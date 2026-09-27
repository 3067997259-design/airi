import dev.mcpfabric.client.flight.FlightDynamics;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;

/**
 * Read-only audit of the measured ab-17 tick boundary against the production model.
 * The alternative update order is a diagnostic hypothesis, not a production fix.
 * No terrain is fabricated or queried. This probe cannot certify collision clearance.
 *
 * Call stack:
 *
 * main
 *   -> {@link FlightDynamics#step}
 *   -> compare predicted state with the next recorded sample
 */
class AuditDynamics {
    private static double number(String[] row, int column) {
        return Double.parseDouble(row[column]);
    }

    private static double distance(double x, double y, double z) {
        return Math.sqrt(x * x + y * y + z * z);
    }

    public static void main(String[] args) throws Exception {
        List<String[]> rows = Files.readAllLines(Path.of(args[0])).stream()
                .map(line -> line.split(",")).toList();
        System.out.println("arm,tick,boost,fire,position_error_current,position_error_without_boost,velocity_error_current,velocity_error_move_then_boost,actual_dx,actual_dy,actual_dz");
        for (int index = 0; index < rows.size() - 1; index++) {
            String[] current = rows.get(index);
            String[] next = rows.get(index + 1);
            if (!current[0].equals(next[0]) || number(next, 1) != number(current, 1) + 1
                    || !current[12].equals("flight-session")) {
                continue;
            }
            var input = new FlightDynamics.Input((float) number(current, 8),
                    (float) number(current, 9), Boolean.parseBoolean(current[11]));
            var state = new FlightDynamics.State(number(current, 2), number(current, 3),
                    number(current, 4), number(current, 5), number(current, 6),
                    number(current, 7), (int) number(current, 10));
            var predicted = FlightDynamics.step(state, input);
            var airStep = FlightDynamics.step(new FlightDynamics.State(state.x, state.y, state.z,
                    state.vx, state.vy, state.vz, 0),
                    new FlightDynamics.Input(input.yaw, input.pitch, false));
            var look = FlightDynamics.lookVector(input.yaw, input.pitch);
            // Hypothesis: movement precedes rocket acceleration at this sample boundary.
            double boostedX = airStep.vx + look.x * .1 + (look.x * 1.5 - airStep.vx) * .5;
            double boostedY = airStep.vy + look.y * .1 + (look.y * 1.5 - airStep.vy) * .5;
            double boostedZ = airStep.vz + look.z * .1 + (look.z * 1.5 - airStep.vz) * .5;
            double positionError = distance(predicted.x - number(next, 2),
                    predicted.y - number(next, 3), predicted.z - number(next, 4));
            double airPositionError = distance(airStep.x - number(next, 2),
                    airStep.y - number(next, 3), airStep.z - number(next, 4));
            double velocityError = distance(predicted.vx - number(next, 5),
                    predicted.vy - number(next, 6), predicted.vz - number(next, 7));
            double oneBoostError = distance(boostedX - number(next, 5),
                    boostedY - number(next, 6), boostedZ - number(next, 7));
            System.out.printf(Locale.ROOT,
                    "%s,%s,%s,%s,%.8f,%.8f,%.8f,%.8f,%.8f,%.8f,%.8f%n",
                    current[0], current[1], current[10], current[11], positionError,
                    airPositionError, velocityError, oneBoostError,
                    number(next, 2) - state.x, number(next, 3) - state.y, number(next, 4) - state.z);

            if (number(current, 1) >= 19464 && number(current, 1) <= 19469) {
                // A second application tests overlapping rockets, without assuming an entity count.
                double twoBoostError = distance(
                        boostedX + look.x * .1 + (look.x * 1.5 - boostedX) * .5 - number(next, 5),
                        boostedY + look.y * .1 + (look.y * 1.5 - boostedY) * .5 - number(next, 6),
                        boostedZ + look.z * .1 + (look.z * 1.5 - boostedZ) * .5 - number(next, 7));
                System.err.printf(Locale.ROOT,
                        "OVERLAP tick=%s estimate=%s fire=%s error_one_boost=%.8f error_two_boosts=%.8f%n",
                        current[1], current[10], current[11], oneBoostError, twoBoostError);
            }
            if (number(current, 1) == 19220 || number(current, 1) == 19478) {
                var arrival = state;
                for (int tick = 0; tick < 20; tick++) {
                    arrival = FlightDynamics.step(arrival,
                            new FlightDynamics.Input(input.yaw, input.pitch, tick == 0 && input.useRocket));
                    // The terminal waypoint and radius are taken from ab-17 and its submit payload.
                    double gap = distance(arrival.x + 958.5, arrival.y - 81.5, arrival.z + 67.5);
                    if (gap <= 8) {
                        System.err.printf(Locale.ROOT,
                                "ARRIVAL %s tick=%s predictedTicks=%d xyz=%.6f,%.6f,%.6f speed=%.6f vy=%.6f dist=%.6f%n",
                                current[0], current[1], tick + 1, arrival.x, arrival.y, arrival.z,
                                Math.hypot(arrival.vx, arrival.vz), arrival.vy, gap);
                        break;
                    }
                }
            }
        }
    }
}
