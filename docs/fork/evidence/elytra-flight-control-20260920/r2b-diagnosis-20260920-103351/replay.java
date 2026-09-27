import dev.mcpfabric.client.flight.FlightDynamics;
import dev.mcpfabric.client.flight.FlightSession;
import java.util.List;

/** Read-only regression probes against the built R2b classes; no game connection. */
class Replay {
    public static void main(String[] args) {
        var path = List.of(
            new FlightSession.Waypoint(100, 80, 0),
            new FlightSession.Waypoint(200, 80, 0));
        var session = new FlightSession(path, (x, y, z) -> "air",
            Long.MAX_VALUE, new FlightSession.Params());
        int failures = 0;

        // ROOT CAUSE: currentTarget uses entryIndex + 1 before the first entry
        // has been reached. Exercise the public path-following contract.
        var target = session.currentTarget();
        boolean firstEntry = target.equals(path.getFirst());
        System.out.println("unreached-first-entry: " + (firstEntry ? "PASS" : "FAIL")
            + " expected=" + path.getFirst() + " actual=" + target);
        if (!firstEntry) failures++;

        // ROOT CAUSE: the candidate bearing uses the polar angle directly,
        // while FlightDynamics and Minecraft yaw place east at -90 degrees.
        var decision = session.tick(0, 80, 0, 0, 0, 0, -90, 0, 16, 1, false);
        double yawError = Math.abs(Math.IEEEremainder(decision.yaw + 90, 360));
        var look = FlightDynamics.lookVector(decision.yaw, decision.pitch);
        boolean towardEast = !session.isDone() && yawError <= 30;
        System.out.println("east-bearing: " + (towardEast ? "PASS" : "FAIL")
            + " expectedYaw=-90 actualYaw=" + decision.yaw
            + " error=" + yawError + " lookX=" + look.x + " lookZ=" + look.z
            + " note=" + decision.note);
        if (!towardEast) failures++;

        if (failures != 0) throw new AssertionError(failures + " R2b regressions reproduced");
    }
}
