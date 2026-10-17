import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import javax.management.Attribute;
import javax.management.AttributeList;
import javax.management.MBeanAttributeInfo;
import javax.management.MBeanInfo;
import javax.management.MBeanServerConnection;
import javax.management.ObjectInstance;
import javax.management.ObjectName;
import javax.management.remote.JMXConnector;
import javax.management.remote.JMXConnectorFactory;
import javax.management.remote.JMXServiceURL;

/**
 * JMX bridge for the slim Teamcenter management console (mgmt-console-lite).
 * Reads base64 lines from stdin: operation, jmxUrl, managerId, username, password.
 * Writes base64 tab-separated lines to stdout:
 *   S  <attribute name>  <value>        status attribute; String[] values are
 *                                       joined with U+001F so the wrapper can
 *                                       split them per pool
 *   P  <serverId> <pid> <pool> <host> <owner> <state> <durationSec>
 *                                       list: one TC server process; state is
 *                                       Lifecycle, owner is Assigned User
 *   T                                    restart-warm or terminate acknowledged
 *   D  <domain>                          probe: one JMX domain
 *   M  <objectName>  <className>         probe: one MBean
 *   A  <objectName>  <attribute>  <type> <value>
 *                                       probe: full attribute dump of the
 *                                       manager MBean
 *   T  <count>                            probe: total MBean count
 * Any failure exits with code 2 and a one-line stderr message.
 */
public final class MgrJmxBridge {
    // Exact attribute names read from the TC 14.2.0.2 console bundle
    // (ServerManagerServiceImpl.serverStatusAttNames); values are String[], one
    // entry per pool managed by the Server Manager.
    private static final String[] STATUS_ATTRIBUTES = {
        "Host", "Active Status", "Assignment Service", "Mux",
        "Number of Servers", "Number of Assigned Servers",
        "Number of Warm Servers", "Number of Warming Up Servers", "Number of Cold Servers",
        "Number of Servers Terminated Before Normal Timeout",
        "Servers in Edit Mode", "Servers in Read Mode", "Servers in Stateless Mode",
        "Last Restart Warm Servers Time"
    };

    private static String decode(String value) {
        return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
    }

    private static String encode(String value) {
        return Base64.getEncoder().encodeToString(String.valueOf(value).getBytes(StandardCharsets.UTF_8));
    }

    private static String read(BufferedReader reader) throws Exception {
        String line = reader.readLine();
        if (line == null) throw new IllegalArgumentException("Incomplete adapter input.");
        return decode(line);
    }

    // Field-proven TC 14.2 domains carry a space after "Administer" and a
    // trailing space before the key list ("Administer PoolA servers "), while the
    // console bundle builds "Administer" + id + " manager :id=" + id without it.
    // queryNames on both spellings and prefer an exact id match so either server
    // spelling works.
    private static ObjectName managerBean(MBeanServerConnection connection, String managerId) throws Exception {
        List<ObjectName> found = new ArrayList<>();
        for (String domain : new String[] { "Administer " + managerId + " manager ", "Administer" + managerId + " manager " }) {
            try {
                found.addAll(connection.queryNames(new ObjectName(domain + ":id=*"), null));
            } catch (Exception ignored) {
                // Malformed domain for this managerId spelling; try the next one.
            }
        }
        for (ObjectName name : found) {
            if (managerId.equals(name.getKeyProperty("id"))) return name;
        }
        if (!found.isEmpty()) return found.get(0);
        throw new IllegalStateException("Server Manager MBean not found (managerId=" + managerId + ")");
    }

    private static String joinValue(Object value) {
        if (value instanceof String[]) return String.join("\u001f", (String[]) value);
        return value == null ? "" : String.valueOf(value);
    }

    private static Object attribute(MBeanServerConnection connection, ObjectName name, String attribute, Object fallback) {
        try {
            Object value = connection.getAttribute(name, attribute);
            return value == null ? fallback : value;
        } catch (Exception ignored) {
            return fallback;
        }
    }

    // TC 14.2 registers server ids as "<name>@<pool>@<non-pid>@<host>"; the pool
    // is the second '@' segment (the third is not the PID — the MBean attribute
    // "Process ID" is authoritative).
    private static String poolFromServerId(String serverId, String managerId) {
        int first = serverId.indexOf('@');
        if (first < 0) return managerId;
        int second = serverId.indexOf('@', first + 1);
        String pool = second > first ? serverId.substring(first + 1, second) : serverId.substring(first + 1);
        return pool.isEmpty() ? managerId : pool;
    }

    // The console shows duration from "Last Message Time"; accept the field-tested
    // spellings and Date / epoch-millis / elapsed-seconds value shapes.
    private static long durationSeconds(MBeanServerConnection connection, ObjectName name) {
        String[] candidates = { "Last Live Message Time", "Last Message Time", "LastLiveMessageTime", "LastMessageTime" };
        for (String candidate : candidates) {
            try {
                long seconds = durationFromValue(connection.getAttribute(name, candidate));
                if (seconds >= 0) return seconds;
            } catch (Exception ignored) {
                // Attribute missing on this build; try the next spelling.
            }
        }
        return 0L;
    }

    private static long durationFromValue(Object value) {
        long now = System.currentTimeMillis();
        if (value instanceof Date) return Math.max(0L, (now - ((Date) value).getTime()) / 1000L);
        if (value instanceof Number) {
            long number = ((Number) value).longValue();
            if (number >= 1_000_000_000_000L) return Math.max(0L, (now - number) / 1000L);
            if (number > 0L && number < 100_000_000L) return number;
        }
        return -1L;
    }

    private static Set<String> allowedPools(String text) {
        Set<String> values = new HashSet<>();
        if (!text.isEmpty()) {
            for (String value : text.split("\\u001f", -1)) if (!value.isEmpty()) values.add(value);
        }
        return values;
    }

    private static List<ProcessInfo> processes(MBeanServerConnection connection, String managerId, Set<String> pools, String host) throws Exception {
        // Field-proven domain spelling keeps its space after "Administer"; the
        // alternate no-space spelling is accepted for other TC builds.
        ObjectName pattern = new ObjectName("Administer " + managerId + " servers :id=*");
        Set<ObjectInstance> beans = connection.queryMBeans(pattern, null);
        if (beans.isEmpty()) beans = connection.queryMBeans(new ObjectName("Administer" + managerId + " servers :id=*"), null);
        List<ProcessInfo> result = new ArrayList<>();
        for (ObjectInstance bean : beans) {
            if (!"com.teamcenter.jeti.serversubpoolmanager.ServerInfo".equals(bean.getClassName())) continue;
            ObjectName name = bean.getObjectName();
            String serverId = name.getKeyProperty("id");
            if (serverId == null || serverId.isEmpty()) continue;
            String pool = poolFromServerId(serverId, managerId);
            if (!pools.isEmpty() && !pools.contains(pool)) continue;
            String pid = String.valueOf(attribute(connection, name, "Process ID", ""));
            String owner = String.valueOf(attribute(connection, name, "Assigned User", ""));
            // Console columns: Lifecycle comes from the Assigned/Ready booleans,
            // Mode from State (Read/Stateless/Edit), Status from Active.
            boolean assigned = Boolean.TRUE.equals(attribute(connection, name, "Assigned", Boolean.FALSE));
            boolean ready = Boolean.TRUE.equals(attribute(connection, name, "Ready", Boolean.FALSE));
            String lifecycle = assigned ? "Assigned" : (ready ? "Ready" : "");
            String mode = String.valueOf(attribute(connection, name, "State", ""));
            boolean active = Boolean.TRUE.equals(attribute(connection, name, "Active", Boolean.FALSE));
            long duration = durationSeconds(connection, name);
            result.add(new ProcessInfo(name, serverId, pid, pool, host, owner, lifecycle, mode, active ? "Active" : "Idle", duration));
        }
        return result;
    }

    private static void list(MBeanServerConnection connection, String managerId, String host, String poolsText) throws Exception {
        for (ProcessInfo process : processes(connection, managerId, allowedPools(poolsText), host)) {
            System.out.println("P\t" + encode(process.serverId) + "\t" + encode(process.pid) + "\t" +
                encode(process.pool) + "\t" + encode(process.host) + "\t" + encode(process.owner) + "\t" +
                encode(process.lifecycle) + "\t" + encode(process.mode) + "\t" + encode(process.status) + "\t" +
                encode(String.valueOf(process.duration)));
        }
    }

    private static void terminate(MBeanServerConnection connection, String managerId, String host, String poolsText, String requestedServerId) throws Exception {
        ProcessInfo selected = null;
        for (ProcessInfo process : processes(connection, managerId, allowedPools(poolsText), host)) {
            if (process.serverId.equals(requestedServerId)) {
                selected = process;
                break;
            }
        }
        if (selected == null) throw new IllegalStateException("Process not found (serverId=" + requestedServerId + ")");
        connection.invoke(selected.objectName, "Shutdown_Server", new Object[] { selected.serverId }, null);
        System.out.println("T");
    }

    private static void status(MBeanServerConnection connection, String managerId) throws Exception {
        ObjectName manager = managerBean(connection, managerId);
        AttributeList attributes = connection.getAttributes(manager, STATUS_ATTRIBUTES);
        Set<String> reported = new TreeSet<>();
        for (Object item : attributes.asList()) {
            Attribute attribute = (Attribute) item;
            reported.add(attribute.getName());
            System.out.println("S\t" + encode(attribute.getName()) + "\t" + encode(joinValue(attribute.getValue())));
        }
        // Missing attributes are reported as empty so the page never shows stale
        // values from a previous refresh for the same target.
        for (String name : STATUS_ATTRIBUTES) {
            if (!reported.contains(name)) System.out.println("S\t" + encode(name) + "\t" + encode(""));
        }
    }

    private static void restartWarm(MBeanServerConnection connection, String managerId) throws Exception {
        ObjectName manager = managerBean(connection, managerId);
        connection.invoke(manager, "Restart_Warm_Servers", null, null);
        System.out.println("T");
    }

    // Diagnostic operation, reachable only from a local shell (never through the
    // web application): dump domains and Administer beans so a real Server
    // Manager can be inspected when the manager MBean is not found.
    private static void probe(MBeanServerConnection connection, String managerId) throws Exception {
        Set<String> domains = new TreeSet<>(java.util.Arrays.asList(connection.getDomains()));
        for (String domain : domains) System.out.println("D\t" + encode(domain));
        Set<ObjectInstance> all = connection.queryMBeans(new ObjectName("*:*"), null);
        ObjectName manager = null;
        try {
            manager = managerBean(connection, managerId);
        } catch (Exception ignored) {
            // Probe must keep working even without a manager MBean.
        }
        for (ObjectInstance bean : all) {
            ObjectName name = bean.getObjectName();
            String domain = name == null ? "" : name.getDomain();
            if (domain.startsWith("Administer") || (manager != null && manager.equals(name))) {
                System.out.println("M\t" + encode(String.valueOf(name)) + "\t" + encode(String.valueOf(bean.getClassName())));
            }
        }
        if (manager != null) {
            MBeanInfo info = connection.getMBeanInfo(manager);
            MBeanAttributeInfo[] declared = info.getAttributes();
            String[] names = new String[declared.length];
            for (int index = 0; index < declared.length; index++) names[index] = declared[index].getName();
            AttributeList values = connection.getAttributes(manager, names);
            for (Object item : values.asList()) {
                Attribute attribute = (Attribute) item;
                Object value = attribute.getValue();
                System.out.println("A\t" + encode(manager.toString()) + "\t" + encode(attribute.getName()) + "\t" +
                    encode(value == null ? "null" : value.getClass().getName()) + "\t" +
                    encode(value instanceof String[] ? String.join("\u001f", (String[]) value) : String.valueOf(value)));
            }
        }
        System.out.println("T\t" + encode(String.valueOf(all.size())));
    }

    // ----- per-TC-server management (Logging / Log Levels / Monitoring) -----
    // All names below are byte-for-byte the ones used by the TC 14.2.0.2
    // console bundles (TcServerServiceImpl / MldServiceImpl), including the
    // quirky spellings: two spaces in "SQL  Logging Enabled", the capital J in
    // the "Java.lang.Integer" signature of Show_Syslog/Show_Journal_File, and
    // the "Stop_Writing_Journal_Entires" typo.

    private static final String[] SERVER_LOG_STATUS_ATTRIBUTES = {
        "Checking Level", "Journal Log", "Journal Performance-only", "Journal Statistics",
        "SQL  Logging Enabled", "SQL Profile", "SQL Show Bind Variables", "SQL Timing", "SQL To the Journal file"
    };

    private static ObjectName serverInfoBean(MBeanServerConnection connection, String serverId, String managerId) throws Exception {
        for (String domain : new String[] { "Administer " + managerId + " servers ", "Administer" + managerId + " servers " }) {
            try {
                ObjectName exact = new ObjectName(domain + ":id=" + serverId);
                if (connection.isRegistered(exact)) return exact;
            } catch (Exception ignored) {
                // Try the next domain spelling.
            }
        }
        throw new IllegalStateException("ServerInfo MBean not found (serverId=" + serverId + ")");
    }

    // Console: ServerInfo attribute "Server Log Configuration" -> the per-server
    // ServerLogConfiguration MBean. Falls back to the console's constructed name.
    private static ObjectName serverLogConfigurationBean(MBeanServerConnection connection, String managerId, String serverId) throws Exception {
        try {
            ObjectName configured = (ObjectName) connection.getAttribute(serverInfoBean(connection, serverId, managerId), "Server Log Configuration");
            if (configured != null) return configured;
        } catch (Exception ignored) {
            // Fall through to the constructed name below.
        }
        return new ObjectName("ServerLogConfiguration:server=" + serverId);
    }

    // Console: ServerLogConfiguration attribute "Logging Levels" -> the
    // per-server LoggingLevels MBean.
    private static ObjectName loggingLevelsBean(MBeanServerConnection connection, ObjectName logConfiguration) throws Exception {
        ObjectName name = (ObjectName) connection.getAttribute(logConfiguration, "Logging Levels");
        if (name == null) throw new IllegalStateException("Logging Levels MBean not configured.");
        return name;
    }

    private static String serverPoolId(String serverId) {
        String[] parts = serverId.split("@");
        return parts.length > 1 ? parts[1] : "";
    }

    // Monitoring domain spellings: the field-proven servers domain carries a
    // space after "Administer", the console bundle builds without it; try both.
    private static ObjectName monitoringBean(MBeanServerConnection connection, String serverId, String keyProperties) throws Exception {
        String poolId = serverPoolId(serverId);
        Exception last = null;
        for (String domain : new String[] { "Administer " + poolId + " servers monitoring", "Administer" + poolId + " servers monitoring" }) {
            try {
                ObjectName name = new ObjectName(domain + keyProperties);
                if (connection.isRegistered(name)) return name;
            } catch (Exception error) {
                last = error;
            }
        }
        if (last != null) throw last;
        throw new IllegalStateException("Monitoring MBean not found: " + keyProperties);
    }

    private static void serverLogStatus(MBeanServerConnection connection, String managerId, String serverId) throws Exception {
        AttributeList attributes = connection.getAttributes(
            serverLogConfigurationBean(connection, managerId, serverId), SERVER_LOG_STATUS_ATTRIBUTES);
        Set<String> reported = new TreeSet<>();
        for (Object item : attributes.asList()) {
            Attribute attribute = (Attribute) item;
            reported.add(attribute.getName());
            System.out.println("L\t" + encode(attribute.getName()) + "\t" + encode(joinValue(attribute.getValue())));
        }
        for (String name : SERVER_LOG_STATUS_ATTRIBUTES) {
            if (!reported.contains(name)) System.out.println("L\t" + encode(name) + "\t" + encode(""));
        }
    }

    private static void setSqlLogging(MBeanServerConnection connection, String managerId, String serverId, String flags) throws Exception {
        String[] values = flags.split(",", -1);
        if (values.length != 5) throw new IllegalArgumentException("Expected 5 SQL logging flags.");
        Boolean[] booleans = new Boolean[5];
        for (int index = 0; index < 5; index++) booleans[index] = "true".equals(values[index].trim());
        ObjectName logConfiguration = serverLogConfigurationBean(connection, managerId, serverId);
        connection.invoke(logConfiguration, "Change_SQL_Logging", booleans,
            new String[] { "java.lang.Boolean", "java.lang.Boolean", "java.lang.Boolean", "java.lang.Boolean", "java.lang.Boolean" });
        System.out.println("T");
    }

    private static void showLog(MBeanServerConnection connection, String managerId, String serverId, String operation, String maxKbText) throws Exception {
        int maxKb = 2000;
        try { maxKb = Integer.parseInt(maxKbText.trim()); } catch (Exception ignored) { }
        ObjectName logConfiguration = serverLogConfigurationBean(connection, managerId, serverId);
        Object content = connection.invoke(logConfiguration, operation,
            new Object[] { Integer.valueOf(maxKb) }, new String[] { "Java.lang.Integer" });
        System.out.println("C\t" + encode(content == null ? "" : String.valueOf(content)));
    }

    private static void journalAction(MBeanServerConnection connection, String managerId, String serverId, String action, String arg2) throws Exception {
        ObjectName logConfiguration = serverLogConfigurationBean(connection, managerId, serverId);
        if ("start-full".equals(action)) {
            connection.invoke(logConfiguration, "Start_Writing_Journal_Entries", new Object[] { null }, new String[] { null });
        } else if ("start-perf".equals(action)) {
            int maxEntries = 0;
            try { maxEntries = Integer.parseInt(arg2.trim()); } catch (Exception ignored) { }
            connection.invoke(logConfiguration, "Start_Writing_Journal_Entries",
                new Object[] { Integer.valueOf(maxEntries) }, new String[] { "java.lang.Integer" });
        } else if ("stop".equals(action)) {
            connection.invoke(logConfiguration, "Stop_Writing_Journal_Entires", new Object[] { null }, new String[] { null });
        } else {
            throw new IllegalArgumentException("Unsupported journal action: " + action);
        }
        System.out.println("T");
    }

    private static void statsAction(MBeanServerConnection connection, String managerId, String serverId, String action) throws Exception {
        ObjectName logConfiguration = serverLogConfigurationBean(connection, managerId, serverId);
        if ("start".equals(action)) {
            connection.invoke(logConfiguration, "Start_Gathering_Statistics", new Object[] { null }, new String[] { null });
        } else if ("stop".equals(action)) {
            connection.invoke(logConfiguration, "Stop_Gathering_Statistics", new Object[] { null }, new String[] { null });
        } else if ("clear".equals(action)) {
            connection.invoke(logConfiguration, "Clear_Statistics", new Object[] { null }, new String[] { null });
        } else if ("dump".equals(action)) {
            connection.invoke(logConfiguration, "Dump_Statistics_To_Syslog", new Object[] { null }, new String[] { null });
        } else {
            throw new IllegalArgumentException("Unsupported statistics action: " + action);
        }
        System.out.println("T");
    }

    private static void journalModules(MBeanServerConnection connection, String managerId, String serverId) throws Exception {
        // The console reads ServerInfo "Journaled Modules" -> ObjectName, invokes
        // Refresh_Modules, then every Boolean attribute of that MBean is one
        // module name with its active state.
        ObjectName modulesBean = (ObjectName) connection.getAttribute(
            serverInfoBean(connection, serverId, managerId), "Journaled Modules");
        if (modulesBean == null) throw new IllegalStateException("Journaled Modules MBean not configured.");
        connection.invoke(modulesBean, "Refresh_Modules", new Object[] { null }, new String[] { null });
        MBeanInfo info = connection.getMBeanInfo(modulesBean);
        List<String> names = new ArrayList<>();
        for (MBeanAttributeInfo attribute : info.getAttributes()) {
            if ("java.lang.Boolean".equals(attribute.getType())) names.add(attribute.getName());
        }
        AttributeList values = connection.getAttributes(modulesBean, names.toArray(new String[0]));
        Set<String> reported = new TreeSet<>();
        for (Object item : values.asList()) {
            Attribute attribute = (Attribute) item;
            reported.add(attribute.getName());
            System.out.println("M\t" + encode(attribute.getName()) + "\t" + encode(joinValue(attribute.getValue())));
        }
        for (String name : names) {
            if (!reported.contains(name)) System.out.println("M\t" + encode(name) + "\t" + encode(""));
        }
    }

    private static void setJournalModules(MBeanServerConnection connection, String serverId, String assignments) throws Exception {
        // Console: one ModuleJournaling MBean per server; every module is one
        // Boolean attribute set in a single setAttributes call.
        ObjectName modulesBean = new ObjectName("ModuleJournaling:name=" + serverId);
        AttributeList updates = new AttributeList();
        for (String assignment : assignments.split("\u001f", -1)) {
            if (assignment.isEmpty()) continue;
            int equals = assignment.lastIndexOf('=');
            if (equals <= 0) throw new IllegalArgumentException("Malformed module assignment: " + assignment);
            updates.add(new Attribute(assignment.substring(0, equals), "true".equals(assignment.substring(equals + 1))));
        }
        if (!updates.isEmpty()) connection.setAttributes(modulesBean, updates);
        System.out.println("T");
    }

    private static void logLevels(MBeanServerConnection connection, String managerId, String serverId) throws Exception {
        ObjectName levelsBean = loggingLevelsBean(connection, serverLogConfigurationBean(connection, managerId, serverId));
        connection.invoke(levelsBean, "Refresh_Loggers", new Object[] { null }, new String[] { null });
        MBeanInfo info = connection.getMBeanInfo(levelsBean);
        List<String> names = new ArrayList<>();
        for (MBeanAttributeInfo attribute : info.getAttributes()) {
            if ("java.lang.String".equals(attribute.getType())) names.add(attribute.getName());
        }
        AttributeList values = connection.getAttributes(levelsBean, names.toArray(new String[0]));
        Set<String> reported = new TreeSet<>();
        for (Object item : values.asList()) {
            Attribute attribute = (Attribute) item;
            reported.add(attribute.getName());
            System.out.println("G\t" + encode(attribute.getName()) + "\t" + encode(joinValue(attribute.getValue())));
        }
        for (String name : names) {
            if (!reported.contains(name)) System.out.println("G\t" + encode(name) + "\t" + encode(""));
        }
    }

    private static void setLogLevel(MBeanServerConnection connection, String managerId, String serverId, String logger, String priority) throws Exception {
        if (logger == null || logger.isEmpty()) throw new IllegalArgumentException("Empty logger name.");
        String level = (priority == null || priority.trim().isEmpty()) ? "DEFAULT" : priority.trim();
        ObjectName levelsBean = loggingLevelsBean(connection, serverLogConfigurationBean(connection, managerId, serverId));
        try {
            connection.setAttribute(levelsBean, new Attribute(logger, level));
        } catch (Exception error) {
            // Console fallback: Initialize_Loggers creates the logger node when
            // the level attribute does not exist yet.
            connection.invoke(levelsBean, "Initialize_Loggers",
                new Object[] { logger, level }, new String[] { "java.lang.String", "java.lang.String" });
        }
        System.out.println("T");
    }

    private static void monitoringStatus(MBeanServerConnection connection, String serverId) throws Exception {
        ObjectName configurationBean = monitoringBean(connection, serverId, ":type=Configuration,id=Server_Monitoring_Configurations");
        ObjectName eventsBean = monitoringBean(connection, serverId, ":type=Servers,id=" + serverId);
        String healthMode = "";
        try {
            healthMode = String.valueOf(connection.getAttribute(configurationBean, "Health_monitoring_mode"));
        } catch (Exception ignored) {
            // Monitoring MBeans may not exist yet on this server.
        }
        System.out.println("H\t" + encode(healthMode));

        List<String> metricIds = new ArrayList<>();
        List<String> responderIds = new ArrayList<>();
        try {
            MBeanInfo eventsInfo = connection.getMBeanInfo(eventsBean);
            for (MBeanAttributeInfo attribute : eventsInfo.getAttributes()) {
                if (attribute.getName().startsWith("Metric_Config_")) metricIds.add(attribute.getName().substring("Metric_Config_".length()));
            }
        } catch (Exception ignored) {
            // No metrics configured.
        }
        try {
            MBeanInfo configurationInfo = connection.getMBeanInfo(configurationBean);
            for (MBeanAttributeInfo attribute : configurationInfo.getAttributes()) {
                if (attribute.getName().startsWith("Responder_Config_")) responderIds.add(attribute.getName().substring("Responder_Config_".length()));
            }
        } catch (Exception ignored) {
            // No responders configured.
        }

        for (String metricId : metricIds) {
            String dateStarted = "";
            String historical = "";
            String recent = "";
            String mode = "";
            try {
                Object started = connection.getAttribute(eventsBean, metricId + "_Date_monitoring_started");
                dateStarted = started == null ? "" : String.valueOf(started);
            } catch (Exception ignored) { }
            try {
                historical = String.valueOf(connection.getAttribute(eventsBean, metricId + "_Historical_stats"));
            } catch (Exception ignored) { }
            try {
                recent = String.valueOf(connection.getAttribute(eventsBean, metricId + "_Recent_stats"));
            } catch (Exception ignored) { }
            try {
                mode = String.valueOf(connection.getAttribute(monitoringBean(connection, serverId, ":type=Configuration,id=" + metricId), "Configure_mode"));
            } catch (Exception ignored) { }
            System.out.println("V\t" + encode(metricId) + "\t" + encode(mode) + "\t" + encode(dateStarted) + "\t" + encode(historical) + "\t" + encode(recent));
        }
        for (String responderId : responderIds) {
            System.out.println("R\t" + encode(responderId));
        }
    }

    private static void setMonitoringMode(MBeanServerConnection connection, String serverId, String mode) throws Exception {
        connection.setAttribute(monitoringBean(connection, serverId, ":type=Configuration,id=Server_Monitoring_Configurations"), new Attribute("Health_monitoring_mode", mode));
        System.out.println("T");
    }

    private static void metricEvents(MBeanServerConnection connection, String serverId, String metricId, String kind) throws Exception {
        if (metricId == null || metricId.isEmpty()) throw new IllegalArgumentException("Empty metric id.");
        String attribute = "historical".equals(kind) ? metricId + "_Historical_Events" : metricId + "_Recent_Events";
        String[] events;
        try {
            Object value = connection.getAttribute(monitoringBean(connection, serverId, ":type=Servers,id=" + serverId), attribute);
            events = value instanceof String[] ? (String[]) value : new String[0];
        } catch (Exception error) {
            events = new String[] { "no " + kind + " events" };
        }
        for (String event : events) System.out.println("E\t" + encode(event == null ? "" : event));
    }

    private static void clearMetricHistory(MBeanServerConnection connection, String serverId, String metricId) throws Exception {
        ObjectName eventsBean = monitoringBean(connection, serverId, ":type=Servers,id=" + serverId);
        if ("__ALL__".equals(metricId)) {
            MBeanInfo info = connection.getMBeanInfo(eventsBean);
            Set<String> metricIds = new TreeSet<>();
            for (MBeanAttributeInfo attribute : info.getAttributes()) {
                if (attribute.getName().startsWith("Metric_Config_")) metricIds.add(attribute.getName().substring("Metric_Config_".length()));
            }
            for (String id : metricIds) connection.invoke(eventsBean, "clearHistory", new Object[] { id }, new String[] { "java.lang.String" });
        } else {
            connection.invoke(eventsBean, "clearHistory", new Object[] { metricId }, new String[] { "java.lang.String" });
        }
        System.out.println("T");
    }

    public static void main(String[] args) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String operation = read(reader);
            String jmxUrl = read(reader);
            String managerId = read(reader);
            String pools = read(reader);
            String username = read(reader);
            String password = read(reader);
            String serverId = read(reader);
            String arg1 = reader.ready() ? read(reader) : "";
            String arg2 = reader.ready() ? read(reader) : "";
            if (username.isEmpty()) throw new IllegalArgumentException("Empty JMX username.");

            Map<String, Object> environment = new HashMap<>();
            environment.put(JMXConnector.CREDENTIALS, new String[] { username, password });
            JMXServiceURL serviceUrl = new JMXServiceURL(jmxUrl);
            String host = serviceUrl.getHost().isEmpty() ? hostFromUrl(jmxUrl) : serviceUrl.getHost();
            try (JMXConnector connector = JMXConnectorFactory.connect(serviceUrl, environment)) {
                MBeanServerConnection connection = connector.getMBeanServerConnection();
                if ("status".equals(operation)) {
                    status(connection, managerId);
                } else if ("list".equals(operation)) {
                    list(connection, managerId, host, pools);
                } else if ("terminate".equals(operation)) {
                    if (serverId.isEmpty()) throw new IllegalArgumentException("Empty serverId for terminate.");
                    terminate(connection, managerId, host, pools, serverId);
                } else if ("restart-warm".equals(operation)) {
                    restartWarm(connection, managerId);
                } else if ("server-log-status".equals(operation)) {
                    serverLogStatus(connection, managerId, serverId);
                } else if ("set-sql-logging".equals(operation)) {
                    setSqlLogging(connection, managerId, serverId, arg1);
                } else if ("show-syslog".equals(operation)) {
                    showLog(connection, managerId, serverId, "Show_Syslog", arg1);
                } else if ("show-journal".equals(operation)) {
                    showLog(connection, managerId, serverId, "Show_Journal_File", arg1);
                } else if ("journal-action".equals(operation)) {
                    journalAction(connection, managerId, serverId, arg1, arg2);
                } else if ("stats-action".equals(operation)) {
                    statsAction(connection, managerId, serverId, arg1);
                } else if ("journal-modules".equals(operation)) {
                    journalModules(connection, managerId, serverId);
                } else if ("set-journal-modules".equals(operation)) {
                    setJournalModules(connection, serverId, arg1);
                } else if ("log-levels".equals(operation)) {
                    logLevels(connection, managerId, serverId);
                } else if ("set-log-level".equals(operation)) {
                    setLogLevel(connection, managerId, serverId, arg1, arg2);
                } else if ("monitoring-status".equals(operation)) {
                    monitoringStatus(connection, serverId);
                } else if ("set-monitoring-mode".equals(operation)) {
                    setMonitoringMode(connection, serverId, arg1);
                } else if ("metric-events".equals(operation)) {
                    metricEvents(connection, serverId, arg1, arg2);
                } else if ("clear-metric-history".equals(operation)) {
                    clearMetricHistory(connection, serverId, arg1);
                } else if ("probe".equals(operation)) {
                    probe(connection, managerId);
                } else {
                    throw new IllegalArgumentException("Unsupported operation: " + operation);
                }
            }
        } catch (Exception error) {
            System.err.println(error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()));
            System.exit(2);
        }
    }

    // JMXServiceURL.getHost() returns "" for the common TC form
    // service:jmx:rmi:///jndi/rmi://<host>:<port>/jmxrmi because the host lives
    // in the JNDI section, so extract the last explicit //host from the URL.
    private static String hostFromUrl(String jmxUrl) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("//([^/:]+)").matcher(jmxUrl);
        String host = "";
        while (matcher.find()) {
            if (!matcher.group(1).isEmpty()) host = matcher.group(1);
        }
        return host;
    }

    private static final class ProcessInfo {
        final ObjectName objectName;
        final String serverId;
        final String pid;
        final String pool;
        final String host;
        final String owner;
        final String lifecycle;
        final String mode;
        final String status;
        final long duration;

        ProcessInfo(ObjectName objectName, String serverId, String pid, String pool, String host, String owner, String lifecycle, String mode, String status, long duration) {
            this.objectName = objectName;
            this.serverId = serverId;
            this.pid = pid;
            this.pool = pool;
            this.host = host;
            this.owner = owner;
            this.lifecycle = lifecycle;
            this.mode = mode;
            this.status = status;
            this.duration = duration;
        }
    }
}
