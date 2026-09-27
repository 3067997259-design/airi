import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import dev.mcpfabric.client.flight.FlightDynamics;

/**
 * Offline dynamics calibration over recorded ab-17 tick samples (ab-17 audit
 * item 1): the four boost states (free glide, single rocket, repeated
 * ignition, boost end) and the multi-tick rollout error that has to fit inside
 * the clearance margins.
 *
 * Usage: java CalibrateDynamics <samples.csv>
 * Columns: arm,tick,x,y,z,vx,vy,vz,yaw,pitch,boost,fire,owner,health
 */
public final class CalibrateDynamics {
	private record Row(String arm, int tick, double x, double y, double z, double vx, double vy, double vz,
			float yaw, float pitch, int boost, boolean fire, String owner, double health) {}

	private static final int[] HORIZONS = { 1, 5, 10, 20 };

	public static void main(String[] args) throws Exception {
		List<Row> rows = new ArrayList<>();
		for (String line : Files.readAllLines(Path.of(args[0]))) {
			String[] f = line.split(",");
			if (f.length < 14)
				continue;
			rows.add(new Row(f[0], Integer.parseInt(f[1].trim()),
					Double.parseDouble(f[2]), Double.parseDouble(f[3]), Double.parseDouble(f[4]),
					Double.parseDouble(f[5]), Double.parseDouble(f[6]), Double.parseDouble(f[7]),
					Float.parseFloat(f[8]), Float.parseFloat(f[9]),
					Integer.parseInt(f[10].trim()), Boolean.parseBoolean(f[11].trim()),
					f[12], Double.parseDouble(f[13].trim())));
		}
		rows.sort((a, b) -> a.arm.compareTo(b.arm) != 0 ? a.arm.compareTo(b.arm) : Integer.compare(a.tick, b.tick));
		List<Row> full = rows.stream().filter(r -> r.arm.equals("full")).toList();
		List<Row> segmented = rows.stream().filter(r -> r.arm.equals("segmented")).toList();

		System.out.println("# ab-17 dynamics calibration (audit item 1)\n");
		System.out.println("Samples: full=" + full.size() + " segmented=" + segmented.size() + "\n");
		System.out.println("## Class counts (single steps of consecutive ticks)\n");
		System.out.println("| class | full | segmented |");
		System.out.println("| --- | --- | --- |");
		for (String c : List.of("free", "single", "ignite", "stacked", "boost_end")) {
			System.out.printf("| %s | %d | %d |%n", c,
					countClass(full, c), countClass(segmented, c));
		}

		for (int n : HORIZONS) {
			System.out.printf("%n## Position error after %d tick(s), blocks%n%n", n);
			System.out.println("| class | n | p50 | p95 | max |");
			System.out.println("| --- | --- | --- | --- | --- |");
			for (String c : List.of("free", "free_clean", "single", "single_clean", "ignite", "stacked", "all")) {
				List<Double> errors = new ArrayList<>();
				collectRollout(full, c, n, errors);
				collectRollout(segmented, c, n, errors);
				if (errors.isEmpty()) {
					System.out.printf("| %s | %d | - | - | - |%n", c, errors.size());
					continue;
				}
				errors.sort(Double::compare);
				System.out.printf("| %s | %d | %.6f | %.6f | %.6f |%n", c, errors.size(),
						percentile(errors, 0.50), percentile(errors, 0.95), errors.get(errors.size() - 1));
			}
		}

		System.out.println("\n## Velocity error after N ticks, blocks/tick\n");
		System.out.println("| class | n | p50 | p95 | max |");
		System.out.println("| --- | --- | --- | --- | --- |");
		for (int n : HORIZONS) {
			for (String c : List.of("free", "free_clean", "single", "single_clean", "all")) {
				List<Double> errors = new ArrayList<>();
				collectVelocityRollout(full, c, n, errors);
				collectVelocityRollout(segmented, c, n, errors);
				if (errors.isEmpty())
					continue;
				errors.sort(Double::compare);
				System.out.printf("| %s | %d | %.6f | %.6f | %.6f |%n", c, errors.size(),
						percentile(errors, 0.50), percentile(errors, 0.95), errors.get(errors.size() - 1));
			}
		}
		System.out.println("\nMargins in the running system: client pose-box inflation 0.15 blocks, planner extra tracking margin 0.2 blocks.");
	}

	private static void collectRollout(List<Row> rows, String target, int n, List<Double> errors) {
		for (int i = 0; i + n < rows.size(); i++) {
			Row a = rows.get(i);
			if (!matches(rows, i, n, target))
				continue;
			if (!consecutive(rows, i, n))
				continue;
			FlightDynamics.State state = new FlightDynamics.State(
					a.x, a.y, a.z, a.vx, a.vy, a.vz, Math.max(0, a.boost));
			for (int k = 0; k < n; k++) {
				Row s = rows.get(i + k);
				state = FlightDynamics.step(state, new FlightDynamics.Input(s.yaw, s.pitch, s.fire));
			}
			Row b = rows.get(i + n);
			errors.add(Math.sqrt(sq(state.x - b.x) + sq(state.y - b.y) + sq(state.z - b.z)));
		}
	}

	private static void collectVelocityRollout(List<Row> rows, String target, int n, List<Double> errors) {
		for (int i = 0; i + n < rows.size(); i++) {
			Row a = rows.get(i);
			if (!matches(rows, i, n, target))
				continue;
			if (!consecutive(rows, i, n))
				continue;
			FlightDynamics.State state = new FlightDynamics.State(
					a.x, a.y, a.z, a.vx, a.vy, a.vz, Math.max(0, a.boost));
			for (int k = 0; k < n; k++) {
				Row s = rows.get(i + k);
				state = FlightDynamics.step(state, new FlightDynamics.Input(s.yaw, s.pitch, s.fire));
			}
			Row b = rows.get(i + n);
			errors.add(Math.sqrt(sq(state.vx - b.vx) + sq(state.vy - b.vy) + sq(state.vz - b.vz)));
		}
	}

	/**
	 * Class match for a rollout. The `_clean` classes keep only in-air,
	 * damage-free stretches whose boost state the model can trust: full health
	 * (a contact would have changed it), a driven owner, and no firework
	 * anywhere in the preceding 40 ticks for the free case (a rocket can still
	 * thrust after its countdown is gone — the ab-17 estimate bug).
	 */
	private static boolean matches(List<Row> rows, int i, int n, String target) {
		if (target.equals("free_clean"))
			return cleanFree(rows, i, n);
		if (target.equals("single_clean"))
			return cleanSingle(rows, i, n);
		if (target.equals("all"))
			return true;
		return classification(rows, i).equals(target);
	}

	private static boolean cleanFree(List<Row> rows, int i, int n) {
		for (int k = 0; k <= n; k++) {
			Row r = rows.get(i + k);
			if (r.health < 20.0)
				return false;
			if (k < n && (r.boost > 0 || r.fire))
				return false;
		}
		for (int k = Math.max(0, i - 40); k < i; k++) {
			Row r = rows.get(k);
			if (r.boost > 0 || r.fire)
				return false;
		}
		return true;
	}

	private static boolean cleanSingle(List<Row> rows, int i, int n) {
		for (int k = 0; k <= n; k++) {
			Row r = rows.get(i + k);
			if (r.health < 20.0)
				return false;
			if (k < n && r.fire)
				return false;
		}
		return classification(rows, i).equals("single");
	}

	/** The state class of the step starting at tick i (see the audit's four states). */
	private static String classification(List<Row> rows, int i) {
		Row a = rows.get(i);
		Row b = i + 1 < rows.size() ? rows.get(i + 1) : null;
		if (a.fire && a.boost > 0)
			return "stacked";
		if (a.fire)
			return "ignite";
		if (a.boost > 0)
			return b != null && b.tick == a.tick + 1 && b.boost == 0 ? "boost_end" : "single";
		return "free";
	}

	private static int countClass(List<Row> rows, String target) {
		int count = 0;
		for (int i = 0; i + 1 < rows.size(); i++) {
			Row a = rows.get(i);
			if (rows.get(i + 1).tick != a.tick + 1)
				continue;
			if (classification(rows, i).equals(target))
				count++;
		}
		return count;
	}

	private static boolean consecutive(List<Row> rows, int start, int n) {
		for (int k = 1; k <= n; k++) {
			if (rows.get(start + k).tick != rows.get(start + k - 1).tick + 1)
				return false;
		}
		return true;
	}

	private static double percentile(List<Double> sorted, double p) {
		int index = (int) Math.ceil(p * sorted.size()) - 1;
		return sorted.get(Math.max(0, Math.min(sorted.size() - 1, index)));
	}

	private static double sq(double v) {
		return v * v;
	}
}
