import dev.mcpfabric.client.flight.FlightDynamics;
import dev.mcpfabric.client.flight.FlightSession;
import java.util.List;

/**
 * Offline regression probes for the R2b fix batch (2026-09-20), run against
 * the rebuilt 0.2.35 classes. No game connection, no bot operation.
 *
 * <p>Each probe covers one R2b diagnosis finding; the whole file exits 0 only
 * when all probes pass.
 */
class ReplayFixed {
    public static void main(String[] args) {
        int failures = 0;
        var path = List.of(
            new FlightSession.Waypoint(100, 80, 0),
            new FlightSession.Waypoint(200, 80, 0));

        // Fix 1: the first entry is the target until it is reached.
        var session = new FlightSession(path, (x, y, z) -> "air", Long.MAX_VALUE, new FlightSession.Params());
        var target = session.currentTarget();
        boolean firstEntry = target.equals(path.get(0));
        System.out.println("unreached-first-entry: " + (firstEntry ? "PASS" : "FAIL")
            + " expected=" + path.get(0) + " actual=" + target);
        if (!firstEntry) failures++;

        // Fix 2: a due-east bearing converts to Minecraft yaw -90.
        var decision = session.tick(-1000, 80, 0, 0, 0, 0, -90, 0, 16, 0, 1, false);
        double yawError = Math.abs(Math.IEEEremainder(decision.yaw + 90, 360));
        var look = FlightDynamics.lookVector(decision.yaw, decision.pitch);
        boolean towardEast = decision.applicable && !session.isDone() && yawError <= 30;
        System.out.println("east-bearing: " + (towardEast ? "PASS" : "FAIL")
            + " expectedYaw=-90 actualYaw=" + decision.yaw
            + " error=" + yawError + " lookX=" + look.x + " lookZ=" + look.z
            + " note=" + decision.note);
        if (!towardEast) failures++;

        // Fix 3: entryReach is adopted, not only echoed.
        var reachParams = new FlightSession.Params();
        reachParams.entryReach = 12;
        var reachSession = new FlightSession(path, (x, y, z) -> "air", Long.MAX_VALUE, reachParams);
        reachSession.tick(89, 80, 0, 0, 0, 0, 0, 0, 16, 0, 1, false);
        boolean adopted = reachSession.entryIndex() == 1 && reachSession.entryReach() == 12;
        System.out.println("entry-reach-adopted: " + (adopted ? "PASS" : "FAIL")
            + " entryIndex=" + reachSession.entryIndex() + " entryReach=" + reachSession.entryReach()
            + " target=" + reachSession.currentTarget());
        if (!adopted) failures++;

        // Fix 4: a terminal decision carries no applicable control input.
        var expired = new FlightSession(path, (x, y, z) -> "air",
            System.currentTimeMillis() - 1, new FlightSession.Params());
        var terminal = expired.tick(0, 80, 0, 0, 0, 0, 10, 10, 16, 0, 1, false);
        boolean terminalSafe = !terminal.applicable && expired.isDone();
        System.out.println("terminal-not-applied: " + (terminalSafe ? "PASS" : "FAIL")
            + " applicable=" + terminal.applicable + " done=" + expired.isDone()
            + " note=" + terminal.note);
        if (!terminalSafe) failures++;

        // Fix 5: the handed-over boost remainder enters the prediction.
        var rocketState = FlightDynamics.step(
            new FlightDynamics.State(0, 80, 0, 0, 0, 0, 35),
            new FlightDynamics.Input(-90, 0, false));
        var glideState = FlightDynamics.step(
            new FlightDynamics.State(0, 80, 0, 0, 0, 0, 0),
            new FlightDynamics.Input(-90, 0, false));
        boolean boostHonored = rocketState.vx > 0.5 && rocketState.vx > glideState.vx + 0.3;
        System.out.println("boost-handover: " + (boostHonored ? "PASS" : "FAIL")
            + " rocketVx=" + rocketState.vx + " glideVx=" + glideState.vx);
        if (!boostHonored) failures++;

        if (failures != 0)
            throw new AssertionError(failures + " R2b fix probes failed");
        System.out.println("all R2b fix probes passed");
    }
}
