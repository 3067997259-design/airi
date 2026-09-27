import dev.mcpfabric.client.flight.FlightDynamics;
import dev.mcpfabric.client.flight.FlightSession;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

/** Closed-loop replay using the production pilot and physics on a complete snapshot.
 * Call stack: main -> FlightSession.tick -> FlightDynamics.step -> next measured state.
 * Non-air block ids remain conservative obstacles. No missing cell becomes air.
 */
public final class LandingReplay {
    private static FlightSession.BlockQuery readWorld(Path root) throws Exception {
        Properties meta = new Properties();
        try (var in = Files.newInputStream(root.resolve("world.properties"))) { meta.load(in); }
        int x0 = Integer.parseInt(meta.getProperty("x0")), x1 = Integer.parseInt(meta.getProperty("x1"));
        int y0 = Integer.parseInt(meta.getProperty("y0")), y1 = Integer.parseInt(meta.getProperty("y1"));
        int z0 = Integer.parseInt(meta.getProperty("z0")), z1 = Integer.parseInt(meta.getProperty("z1"));
        int nx = x1 - x0 + 1, nz = z1 - z0 + 1;
        ByteBuffer cells = ByteBuffer.wrap(Files.readAllBytes(root.resolve("world.bin"))).order(ByteOrder.LITTLE_ENDIAN);
        return (px, py, pz) -> {
            int x = (int)Math.floor(px), y = (int)Math.floor(py), z = (int)Math.floor(pz);
            if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) return null;
            int id = Short.toUnsignedInt(cells.getShort(2 * ((x - x0) + nx * ((z - z0) + nz * (y - y0)))));
            return meta.getProperty("palette." + id);
        };
    }
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        var current = readWorld(root);
        var prior = readWorld(root.resolve("../elytra-local-passages-20260926"));
        FlightSession.BlockQuery world = (x,y,z) -> {
            String id = current.idAt(x,y,z);
            return id == null ? prior.idAt(x,y,z) : id;
        };
        List<FlightSession.Waypoint> route = new ArrayList<>();
        for (String row : Files.readAllLines(root.resolve("route.tsv"))) {
            String[] c = row.split("\\s+");
            route.add(new FlightSession.Waypoint(Double.parseDouble(c[0]), Double.parseDouble(c[1]), Double.parseDouble(c[2])));
        }
        double speed = args.length > 1 ? Double.parseDouble(args[1]) : 1.4;
        double yOffset = args.length > 2 ? Double.parseDouble(args[2]) : 0;
        int boost = args.length > 3 ? Integer.parseInt(args[3]) : 0;
        FlightSession.Params params = new FlightSession.Params();
        params.simBudgetMs = 1_000;
        params.stopAtEnd = true;
        if (args.length > 5) params.entryReach = Double.parseDouble(args[5]);
        if (args.length > 6) params.horizonTicks = Integer.parseInt(args[6]);
        FlightSession pilot = new FlightSession(route, world, System.currentTimeMillis() + 120_000, params, 0);
        var first = route.get(0);
        var aim = route.get(Math.min(5, route.size() - 1));
        double dx = aim.x() - first.x(), dz = aim.z() - first.z(), length = Math.hypot(dx, dz);
        float yaw = (float)(Math.toDegrees(Math.atan2(dz, dx)) - 90), pitch = 0;
        FlightDynamics.State state = new FlightDynamics.State(first.x(), first.y() + yOffset, first.z(), speed * dx / length, 0, speed * dz / length, boost);
        int rockets = 64;
        List<String> measured = args.length > 4 && !args[4].equals("-") ? Files.readAllLines(root.resolve(args[4])) : List.of();
        System.out.println("tick\tx\ty\tz\tyaw\tpitch\tvx\tvy\tvz\tboost\tfire\tcursor\tnote");
        for (int tick = 0; tick < 250; tick++) {
            if (!measured.isEmpty()) {
                if (tick >= measured.size()) break;
                double[] m = java.util.Arrays.stream(measured.get(tick).split("\\s+")).mapToDouble(Double::parseDouble).toArray();
                state = new FlightDynamics.State(m[0],m[1],m[2],m[3],m[4],m[5],(int)m[6]);
                yaw = (float)m[7]; pitch = (float)m[8]; rockets = (int)m[9];
            }
            var terminal = route.get(route.size() - 1);
            boolean coast = args.length > 7 && Math.hypot(state.x-terminal.x(), state.z-terminal.z()) < Double.parseDouble(args[7]);
            var action = pilot.tick(state.x, state.y, state.z, state.vx, state.vy, state.vz, yaw, pitch, coast ? 0 : rockets, state.rocketTicksRemaining, tick, false);
            System.out.printf(java.util.Locale.ROOT, "%d\t%.3f\t%.3f\t%.3f\t%.2f\t%.2f\t%.3f\t%.3f\t%.3f\t%d\t%b\t%d\t%s%n",tick,state.x,state.y,state.z,action.yaw,action.pitch,state.vx,state.vy,state.vz,state.rocketTicksRemaining,action.fireRocket,action.cursor,action.applicable ? action.chosenPolicy : action.note);
            if (!action.applicable || pilot.isDone()) break;
            state = FlightDynamics.step(state, new FlightDynamics.Input(action.yaw, action.pitch, action.fireRocket));
            yaw = action.yaw; pitch = action.pitch;
            if (action.fireRocket) rockets--;
        }
    }
}
