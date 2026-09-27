import dev.mcpfabric.client.flight.FlightDynamics;
import dev.mcpfabric.client.flight.FlightOwnership;

/** Offline audit of production ownership and two ab-24 collision-adjacent states. */
class Ab24AuditProbe {
    private static void ownership(String phase) {
        FlightOwnership value = new FlightOwnership();
        value.startRoute(30_000);
        value.routeFailed("no_viable_trajectory", 1_000, 6_000, 30_000);
        if (phase.equals("LAND")) value.enterLanding();
        System.out.printf("phase=%s at=7001 hard=30000 live=%s acceptBlock=%s%n",
                value.phase(), value.hasLiveControl(7_001), value.acceptBlockReason(7_001));
        if (value.hasLiveControl(7_001) || value.acceptBlockReason(7_001) != null)
            throw new AssertionError("The reviewed soft-deadline gap changed; review this probe.");
    }

    private static void step(int tick, FlightDynamics.State state) {
        FlightDynamics.State next = FlightDynamics.step(state,
                new FlightDynamics.Input(54.556152f, -20f, false));
        System.out.printf(java.util.Locale.ROOT,
                "unobstructed %d->%d x=%.9f y=%.9f z=%.9f vx=%.9f vy=%.9f vz=%.9f%n",
                tick, tick + 1, next.x, next.y, next.z, next.vx, next.vy, next.vz);
    }

    public static void main(String[] args) {
        ownership("RECOVER");
        ownership("LAND");
        step(10000, new FlightDynamics.State(
                -1025.3141702288076, 101.62290560799126, -48.90658754305001,
                -.8044590955600897, .5311418099277351, .30190836070309396, 0));
        step(10001, new FlightDynamics.State(
                -1025.699999988079, 102.1538018911529, -48.59432993344719,
                0, .5308962831616448, .3122576096028178, 0));
    }
}
