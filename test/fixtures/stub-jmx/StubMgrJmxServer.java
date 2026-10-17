import java.lang.management.ManagementFactory;
import java.net.ServerSocket;
import java.rmi.registry.LocateRegistry;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.management.Attribute;
import javax.management.AttributeList;
import javax.management.DynamicMBean;
import javax.management.MBeanAttributeInfo;
import javax.management.MBeanConstructorInfo;
import javax.management.MBeanInfo;
import javax.management.MBeanNotificationInfo;
import javax.management.MBeanOperationInfo;
import javax.management.MBeanServer;
import javax.management.ObjectName;
import javax.management.remote.JMXAuthenticator;
import javax.management.remote.JMXConnectorServer;
import javax.management.remote.JMXConnectorServerFactory;
import javax.management.remote.JMXServiceURL;
import javax.security.auth.Subject;

/**
 * Local-only JMX stub emulating the TC 14.2 Server Manager MBean surface used by
 * mgmt-console-lite: manager domain "Administer <managerId> manager " (the
 * field-proven spelling, space after Administer), a single manager MBean with
 * the console's String[] status attributes, the Restart_Warm_Servers operation,
 * plus a couple of ServerInfo beans for the probe. No Teamcenter code involved.
 *
 * stdout protocol: "READY <jmxServiceUrl>" once listening, "RESTARTWARM" per
 * Restart_Warm_Servers call. Credentials are test-operator / stub-secret; any
 * other pair is rejected with SecurityException like the real LDAP-backed JMX.
 */
public final class StubMgrJmxServer {
    private static final String MANAGER_CLASS = "com.teamcenter.jeti.servermanager.ServerManagerInfo";
    private static final String SERVER_CLASS = "com.teamcenter.jeti.serversubpoolmanager.ServerInfo";

    private static final class ManagerBean implements DynamicMBean {
        private final ObjectName objectName;
        private final Map<String, String[]> attributes = new HashMap<>();

        ManagerBean(ObjectName objectName, String managerId) {
            this.objectName = objectName;
            attributes.put("Host", new String[] { "STUBHOST-01" });
            attributes.put("Active Status", new String[] { "true" });
            attributes.put("Assignment Service", new String[] { "http://STUBHOST-01:8086/" + managerId });
            attributes.put("Mux", new String[] { "http://STUBHOST-01:8087" });
            attributes.put("Number of Servers", new String[] { "3" });
            attributes.put("Number of Assigned Servers", new String[] { "2" });
            attributes.put("Number of Warm Servers", new String[] { "1" });
            attributes.put("Number of Warming Up Servers", new String[] { "0" });
            attributes.put("Number of Cold Servers", new String[] { "0" });
            attributes.put("Number of Servers Terminated Before Normal Timeout", new String[] { "0" });
            attributes.put("Servers in Edit Mode", new String[] { "0" });
            attributes.put("Servers in Read Mode", new String[] { "1" });
            attributes.put("Servers in Stateless Mode", new String[] { "1" });
            attributes.put("Last Restart Warm Servers Time", new String[] { "Mon Oct 05 19:27:15 CST 2026" });
        }

        @Override
        public MBeanInfo getMBeanInfo() {
            List<MBeanAttributeInfo> list = new ArrayList<>();
            for (String name : attributes.keySet()) {
                list.add(new MBeanAttributeInfo(name, "[Ljava.lang.String;", name, true, false, false));
            }
            return new MBeanInfo(MANAGER_CLASS, "Stub ServerManager",
                list.toArray(new MBeanAttributeInfo[0]),
                new MBeanConstructorInfo[0],
                new MBeanOperationInfo[] { new MBeanOperationInfo("Restart_Warm_Servers", "restart warm servers", null, "void", MBeanOperationInfo.ACTION) },
                new MBeanNotificationInfo[0]);
        }

        @Override
        public Object getAttribute(String attribute) {
            String[] value = attributes.get(attribute);
            if (value == null) throw new RuntimeException("Unknown attribute: " + attribute);
            return value;
        }

        @Override
        public void setAttribute(Attribute attribute) { throw new RuntimeException("Read-only stub."); }

        @Override
        public AttributeList getAttributes(String[] names) {
            AttributeList result = new AttributeList();
            for (String name : names) {
                if (attributes.containsKey(name)) result.add(new Attribute(name, attributes.get(name)));
            }
            return result;
        }

        @Override
        public AttributeList setAttributes(AttributeList list) { return new AttributeList(); }

        @Override
        public Object invoke(String actionName, Object[] params, String[] signature) {
            if ("Restart_Warm_Servers".equals(actionName)) {
                attributes.put("Last Restart Warm Servers Time", new String[] { new java.util.Date().toString() });
                attributes.put("Number of Warm Servers", new String[] { "3" });
                System.out.println("RESTARTWARM");
                System.out.flush();
                return "Restart_Warm_Servers done";
            }
            throw new RuntimeException("Unsupported operation: " + actionName);
        }
    }

    private static final class ServerInfoBean implements DynamicMBean {
        private final ObjectName objectName;
        private final String serverId;
        private final String pid;
        private final String owner;
        private final String mode;
        private final boolean assigned;
        private final boolean ready;
        private final boolean active;
        private final ObjectName logConfiguration;
        private final ObjectName journaledModules;

        ServerInfoBean(ObjectName objectName, String serverId, String pid, String owner, String mode, boolean assigned, boolean ready, boolean active, ObjectName logConfiguration, ObjectName journaledModules) {
            this.objectName = objectName;
            this.serverId = serverId;
            this.pid = pid;
            this.owner = owner;
            this.mode = mode;
            this.assigned = assigned;
            this.ready = ready;
            this.active = active;
            this.logConfiguration = logConfiguration;
            this.journaledModules = journaledModules;
        }

        Object getExtraAttribute(String attribute) {
            switch (attribute) {
                case "Server Log Configuration": return logConfiguration;
                case "Journaled Modules": return journaledModules;
                default: return null;
            }
        }

        @Override
        public MBeanInfo getMBeanInfo() {
            List<MBeanAttributeInfo> list = new ArrayList<>();
            list.add(new MBeanAttributeInfo("Process ID", "java.lang.String", "pid", true, false, false));
            list.add(new MBeanAttributeInfo("Assigned User", "java.lang.String", "owner", true, false, false));
            list.add(new MBeanAttributeInfo("State", "java.lang.String", "mode", true, false, false));
            list.add(new MBeanAttributeInfo("Assigned", "java.lang.Boolean", "assigned", true, false, false));
            list.add(new MBeanAttributeInfo("Ready", "java.lang.Boolean", "ready", true, false, false));
            list.add(new MBeanAttributeInfo("Active", "java.lang.Boolean", "active", true, false, false));
            list.add(new MBeanAttributeInfo("Last Live Message Time", Date.class.getName(), "lastLive", true, false, false));
            list.add(new MBeanAttributeInfo("Server Log Configuration", ObjectName.class.getName(), "logConfiguration", true, false, false));
            list.add(new MBeanAttributeInfo("Journaled Modules", ObjectName.class.getName(), "journaledModules", true, false, false));
            return new MBeanInfo(SERVER_CLASS, "Stub ServerInfo",
                list.toArray(new MBeanAttributeInfo[0]),
                new MBeanConstructorInfo[0],
                new MBeanOperationInfo[] { new MBeanOperationInfo("Shutdown_Server", "stop the server", null, "void", MBeanOperationInfo.ACTION) },
                new MBeanNotificationInfo[0]);
        }

        @Override
        public Object getAttribute(String attribute) {
            switch (attribute) {
                case "Process ID": return pid;
                case "Assigned User": return owner;
                case "State": return mode;
                case "Assigned": return assigned;
                case "Ready": return ready;
                case "Active": return active;
                case "Last Live Message Time": return new Date(System.currentTimeMillis() - 120_000L);
                default: {
                    Object extra = getExtraAttribute(attribute);
                    if (extra != null) return extra;
                    throw new RuntimeException("Unknown attribute: " + attribute);
                }
            }
        }

        @Override
        public void setAttribute(Attribute attribute) { throw new RuntimeException("Read-only stub."); }

        @Override
        public AttributeList getAttributes(String[] names) {
            AttributeList result = new AttributeList();
            for (String name : names) {
                try {
                    result.add(new Attribute(name, getAttribute(name)));
                } catch (RuntimeException ignored) {
                    // Not an attribute of this bean.
                }
            }
            return result;
        }

        @Override
        public AttributeList setAttributes(AttributeList list) { return new AttributeList(); }

        @Override
        public Object invoke(String actionName, Object[] params, String[] signature) {
            if ("Shutdown_Server".equals(actionName)) {
                System.out.println("SHUTDOWN " + serverId);
                System.out.flush();
                try {
                    ManagementFactory.getPlatformMBeanServer().unregisterMBean(objectName);
                } catch (Exception error) {
                    throw new RuntimeException(error);
                }
                return null;
            }
            throw new RuntimeException("Unsupported operation: " + actionName);
        }
    }

    /**
     * Generic map-backed DynamicMBean used to emulate the ServerLogConfiguration,
     * LoggingLevels, ModuleJournaling and monitoring MBeans. Attributes are
     * (name, value) pairs with the type inferred from the value; operations map
     * name to a small handler.
     */
    private static final class GenericBean implements DynamicMBean {
        private final Map<String, Object> attributes = new LinkedHashMap<>();
        private final Map<String, java.util.function.Function<Object[], Object>> operations = new HashMap<>();
        private final String className;

        GenericBean(String className) { this.className = className; }

        GenericBean attr(String name, Object value) { attributes.put(name, value); return this; }

        GenericBean op(String name, java.util.function.Function<Object[], Object> handler) { operations.put(name, handler); return this; }

        @Override
        public MBeanInfo getMBeanInfo() {
            List<MBeanAttributeInfo> list = new ArrayList<>();
            for (Map.Entry<String, Object> entry : attributes.entrySet()) {
                String type = entry.getValue() instanceof Boolean ? "java.lang.Boolean"
                    : entry.getValue() instanceof Integer ? "java.lang.Integer"
                    : entry.getValue() instanceof Date ? Date.class.getName()
                    : entry.getValue() instanceof String[] ? "[Ljava.lang.String;"
                    : "java.lang.String";
                list.add(new MBeanAttributeInfo(entry.getKey(), type, entry.getKey(), true, true, false));
            }
            List<MBeanOperationInfo> ops = new ArrayList<>();
            for (String name : operations.keySet()) {
                ops.add(new MBeanOperationInfo(name, name, null, "java.lang.Object", MBeanOperationInfo.ACTION));
            }
            return new MBeanInfo(className, "Stub bean",
                list.toArray(new MBeanAttributeInfo[0]),
                new MBeanConstructorInfo[0],
                ops.toArray(new MBeanOperationInfo[0]),
                new MBeanNotificationInfo[0]);
        }

        @Override
        public Object getAttribute(String attribute) {
            if (!attributes.containsKey(attribute)) throw new RuntimeException("Unknown attribute: " + attribute);
            return attributes.get(attribute);
        }

        @Override
        public void setAttribute(Attribute attribute) {
            if (!attributes.containsKey(attribute.getName())) throw new RuntimeException("Unknown attribute: " + attribute.getName());
            attributes.put(attribute.getName(), attribute.getValue());
        }

        @Override
        public AttributeList getAttributes(String[] names) {
            AttributeList result = new AttributeList();
            for (String name : names) {
                if (attributes.containsKey(name)) result.add(new Attribute(name, attributes.get(name)));
            }
            return result;
        }

        @Override
        public AttributeList setAttributes(AttributeList list) {
            for (Object item : list.asList()) {
                Attribute attribute = (Attribute) item;
                if (attributes.containsKey(attribute.getName())) attributes.put(attribute.getName(), attribute.getValue());
            }
            return new AttributeList();
        }

        @Override
        public Object invoke(String actionName, Object[] params, String[] signature) {
            java.util.function.Function<Object[], Object> handler = operations.get(actionName);
            if (handler == null) throw new RuntimeException("Unsupported operation: " + actionName);
            return handler.apply(params);
        }
    }

    public static void main(String[] args) throws Exception {
        String managerId = args.length > 0 ? args[0] : "PoolA";
        MBeanServer mbeanServer = ManagementFactory.getPlatformMBeanServer();

        ObjectName managerName = new ObjectName("Administer " + managerId + " manager ", "id", managerId);
        mbeanServer.registerMBean(new ManagerBean(managerName, managerId), managerName);

        // Server ids mirror the real TC 14.2 format <name>@<pool>@<non-pid>@<host>;
        // rows mirror the layout of a real Server Manager console (PoolA).
        // The second server is never terminated by tests, so the per-server
        // management wiring (Logging / Log Levels / Monitoring) hangs off it.
        String terminateTargetId = "tcserver00158@" + managerId + "@4144@STUBHOST-01";
        String manageTargetId = "tcserver00313@" + managerId + "@4144@STUBHOST-01";
        ObjectName terminateName = new ObjectName("Administer " + managerId + " servers ", "id", terminateTargetId);
        mbeanServer.registerMBean(new ServerInfoBean(terminateName, terminateName.getKeyProperty("id"), "9496", "infodba", "Read", true, true, false, null, null), terminateName);

        // Holder arrays let the operation lambdas mutate the beans they belong to
        // (direct self-reference would be an uninitialized-variable error).
        final GenericBean[] logConfigHolder = new GenericBean[1];
        final GenericBean[] levelsHolder = new GenericBean[1];

        ObjectName logConfigName = new ObjectName("ServerLogConfiguration:server=" + manageTargetId);
        ObjectName levelsName = new ObjectName("LoggingLevels:server=" + manageTargetId);
        ObjectName modulesName = new ObjectName("ModuleJournaling:name=" + manageTargetId);
        ObjectName manageInfoName = new ObjectName("Administer " + managerId + " servers ", "id", manageTargetId);
        mbeanServer.registerMBean(new ServerInfoBean(manageInfoName, manageInfoName.getKeyProperty("id"), "5464", "infodba", "Stateless", true, false, false, logConfigName, modulesName), manageInfoName);

        GenericBean logConfig = new GenericBean("com.teamcenter.jeti.servermanager.ServerLogConfiguration")
            .attr("Checking Level", Integer.valueOf(0))
            .attr("Journal Log", Boolean.FALSE)
            .attr("Journal Performance-only", Integer.valueOf(0))
            .attr("Journal Statistics", Boolean.FALSE)
            .attr("SQL  Logging Enabled", Boolean.FALSE)
            .attr("SQL Profile", Boolean.FALSE)
            .attr("SQL Show Bind Variables", Boolean.FALSE)
            .attr("SQL Timing", Boolean.FALSE)
            .attr("SQL To the Journal file", Boolean.FALSE)
            .attr("Logging Levels", levelsName)
            .attr("Journaled Modules", modulesName)
            .op("Show_Syslog", (prm) -> "STUB SYSLOG CONTENT maxKb=" + prm[0])
            .op("Show_Journal_File", (prm) -> "STUB JOURNAL CONTENT maxKb=" + prm[0])
            .op("Change_SQL_Logging", (prm) -> {
                String[] sqlNames = { "SQL  Logging Enabled", "SQL Profile", "SQL Show Bind Variables", "SQL Timing", "SQL To the Journal file" };
                for (int index = 0; index < sqlNames.length; index++) logConfigHolder[0].attr(sqlNames[index], prm[index]);
                return Boolean.TRUE;
            })
            .op("Start_Writing_Journal_Entries", (prm) -> Boolean.TRUE)
            .op("Stop_Writing_Journal_Entires", (prm) -> Boolean.TRUE)
            .op("Start_Gathering_Statistics", (prm) -> Boolean.TRUE)
            .op("Stop_Gathering_Statistics", (prm) -> Boolean.TRUE)
            .op("Clear_Statistics", (prm) -> Boolean.TRUE)
            .op("Dump_Statistics_To_Syslog", (prm) -> Boolean.TRUE);
        GenericBean levels = new GenericBean("com.teamcenter.jeti.servermanager.LoggingLevels")
            .attr("Teamcenter", "INFO")
            .attr("Teamcenter.BOMManagement", "INFO*")
            .attr("Teamcenter.Soap", "DEBUG")
            .op("Refresh_Loggers", (prm) -> null)
            .op("Initialize_Loggers", (prm) -> {
                levelsHolder[0].attr(String.valueOf(prm[0]), String.valueOf(prm[1]));
                return null;
            });
        logConfigHolder[0] = logConfig;
        levelsHolder[0] = levels;
        mbeanServer.registerMBean(logConfig, logConfigName);
        mbeanServer.registerMBean(levels, levelsName);

        GenericBean modules = new GenericBean("com.teamcenter.jeti.servermanager.ModuleJournaling")
            .attr("com.teamcenter.rac.kernel", Boolean.FALSE)
            .attr("com.teamcenter.services.loose", Boolean.TRUE)
            .op("Refresh_Modules", (prm) -> null);
        mbeanServer.registerMBean(modules, modulesName);

        // Monitoring: configuration (mode + responders) and the per-server events
        // bean, keyed by the pool id carried inside the serverId.
        String[] metricIds = { "POMRetries", "DBConnectionLosses", "VeryLongRunningQueries", "PomLocks", "Deadlocks" };
        ObjectName monitorConfigName = new ObjectName("Administer " + managerId + " servers monitoring:type=Configuration,id=Server_Monitoring_Configurations");
        GenericBean monitorConfig = new GenericBean("com.teamcenter.jeti.servermanager.MonitoringConfigurations")
            .attr("Health_monitoring_mode", "Off")
            .attr("Responder_Config_EmailResponder1", "")
            .attr("Responder_Config_LoggerResponder1", "");
        mbeanServer.registerMBean(monitorConfig, monitorConfigName);

        GenericBean events = new GenericBean("com.teamcenter.jeti.servermanager.MonitoringServers")
            .op("clearHistory", (prm) -> null);
        for (String metricId : metricIds) {
            events
                .attr("Metric_Config_" + metricId, "")
                .attr(metricId + "_Date_monitoring_started", new Date())
                .attr(metricId + "_Historical_stats", "3")
                .attr(metricId + "_Recent_stats", "1")
                .attr(metricId + "_Recent_Events", new String[] { "recent event A", "recent event B" })
                .attr(metricId + "_Historical_Events", new String[] { "historical event A" });
            ObjectName metricConfigName = new ObjectName("Administer " + managerId + " servers monitoring:type=Configuration,id=" + metricId);
            mbeanServer.registerMBean(new GenericBean("com.teamcenter.jeti.servermanager.MonitoringMetricConfig")
                .attr("Configure_mode", "Collect"), metricConfigName);
        }
        ObjectName eventsName = new ObjectName("Administer " + managerId + " servers monitoring:type=Servers,id=" + manageTargetId);
        mbeanServer.registerMBean(events, eventsName);

        int port;
        try (ServerSocket probe = new ServerSocket(0)) {
            port = probe.getLocalPort();
        }
        LocateRegistry.createRegistry(port);
        JMXServiceURL url = new JMXServiceURL("service:jmx:rmi:///jndi/rmi://localhost:" + port + "/jmxrmi");

        Map<String, Object> environment = new HashMap<>();
        environment.put(JMXConnectorServer.AUTHENTICATOR, (JMXAuthenticator) credentials -> {
            String[] pair = (String[]) credentials;
            if (pair != null && pair.length == 2 && "test-operator".equals(pair[0]) && "stub-secret".equals(pair[1])) {
                return new Subject();
            }
            throw new SecurityException("Authentication failed");
        });
        JMXConnectorServer connector = JMXConnectorServerFactory.newJMXConnectorServer(url, environment, mbeanServer);
        connector.start();

        System.out.println("READY " + url);
        System.out.flush();
        Thread.currentThread().join();
    }
}
