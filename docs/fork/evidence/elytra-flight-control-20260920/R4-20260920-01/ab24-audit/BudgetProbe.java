import java.util.List;

import dev.mcpfabric.client.flight.FlightDynamics;
import dev.mcpfabric.client.flight.FlightSession;

/**
 * Offline cold-start vs warm budget attribution for the route session
 * (ab-24 audit section 4).
 *
 * Usage: java BudgetProbe
 *
 * <p>Runs the production FlightSession in a closed loop: each tick's decision
 * feeds FlightDynamics to advance the measured state. The FIRST session (and
 * its first ticks) run on a cold JVM; a second session with the same state
 * runs warm. Per-tick simMs / physicsSteps / blockQueries / evaluated are
 * printed so the 29 ms first evaluation can be attributed without trimming
 * safety checks.
 */
public final class BudgetProbe {
	private static final int TICKS = 120;

	private record Tick(int index, long simMs, long physicsSteps, long blockQueries, long cacheHits, int evaluated,
			boolean searchCompleted, String budgetReason) {}

	public static void main(String[] args) {
		System.out.println("cold session:");
		runSession("cold", 0);
		System.out.println();
		System.out.println("warm session:");
		runSession("warm", TICKS);
	}

	private static void runSession(String label, long tickOffset) {
		// A representative open-sky route with a mild descent, plus one wall to
		// make the search work: the geometry the route driver meets in the
		// venue (ground far below, a few obstacles).
		FlightSession.BlockQuery blocks = (x, y, z) -> {
			if (y <= 60.0)
				return "minecraft:stone";
			if (x >= 120.0 && x <= 124.0 && y >= 66.0 && y <= 74.0 && Math.abs(z) <= 4.0)
				return "minecraft:oak_leaves";
			return "minecraft:air";
		};
		List<FlightSession.Waypoint> path = List.of(
				new FlightSession.Waypoint(0, 72, 0),
				new FlightSession.Waypoint(80, 70, 0),
				new FlightSession.Waypoint(160, 68, 0),
				new FlightSession.Waypoint(240, 68, 0));
		FlightSession session = new FlightSession(path, blocks, System.currentTimeMillis() + 600_000,
				new FlightSession.Params(), 5_000);

		FlightDynamics.State state = new FlightDynamics.State(0, 72, 0, 1.4, -0.1, 0, 0);
		long totalSimMs = 0;
		java.util.List<Tick> ticks = new java.util.ArrayList<>();
		for (int index = 0; index < TICKS; index++) {
			FlightSession.Decision decision = session.tick(state.x, state.y, state.z,
					state.vx, state.vy, state.vz, 0f, 0f, 0, state.rocketTicksRemaining, tickOffset + index, false);
			ticks.add(new Tick(index, decision.simMs, decision.physicsSteps, decision.blockQueries,
					decision.cacheHits, decision.evaluated, decision.searchCompleted, decision.budgetReason));
			totalSimMs += decision.simMs;
			if (!decision.applicable)
				break;
			state = FlightDynamics.step(state, new FlightDynamics.Input(decision.yaw, decision.pitch, decision.fireRocket));
		}
		for (int index = 0; index < Math.min(8, ticks.size()); index++)
			System.out.println("  " + describe(ticks.get(index)));
		long[] warm = ticks.stream().skip(8).mapToLong(Tick::simMs).sorted().toArray();
		if (warm.length > 0) {
			System.out.printf("  warm ticks=%d p50=%dms p95=%dms max=%dms total=%dms%n",
					warm.length, percentile(warm, 0.50), percentile(warm, 0.95), warm[warm.length - 1], totalSimMs);
			long exhausted = ticks.stream().filter(tick -> !tick.searchCompleted()).count();
			System.out.printf("  search-incomplete ticks=%d%n", exhausted);
		}
	}

	private static String describe(Tick tick) {
		return String.format("  #%d sim=%dms phys=%d queries=%d cacheHits=%d evaluated=%d completed=%s%s",
				tick.index(), tick.simMs(), tick.physicsSteps(), tick.blockQueries(), tick.cacheHits(),
				tick.evaluated(), tick.searchCompleted(),
				tick.budgetReason().isEmpty() ? "" : " reason=" + tick.budgetReason());
	}

	private static long percentile(long[] sorted, double p) {
		int index = (int) Math.ceil(p * sorted.length) - 1;
		return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
	}
}
