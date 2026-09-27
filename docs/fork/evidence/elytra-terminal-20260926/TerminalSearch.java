import dev.mcpfabric.client.flight.FlightDynamics;
import dev.mcpfabric.client.flight.FlightSession;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/** Offline control-sequence experiment; never sends inputs to Minecraft.
 * Call stack: main -> bounded beam -> production physics and swept geometry -> landing check.
 * A found sequence is a model witness, not a live acceptance result.
 */
public final class TerminalSearch {
    record Node(FlightDynamics.State s, float yaw, float pitch, Node parent, int tick, double score) {}
    static double distance(FlightDynamics.State s, FlightSession.Waypoint goal) {
        return Math.sqrt(Math.pow(s.x-goal.x(),2)+Math.pow(s.y-goal.y(),2)+Math.pow(s.z-goal.z(),2));
    }
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        var read = TerminalReplay.class.getDeclaredMethod("readWorld", Path.class);
        read.setAccessible(true);
        var world = (FlightSession.BlockQuery)read.invoke(null, root.resolve("../elytra-landing-20260926"));
        FlightSession.BlockQuery blocks = new FlightSession.BlockQuery() {
            public String idAt(double x,double y,double z) { return world.idAt(x,y,z); }
            public double frictionAt(double x,double y,double z) {
                String id = idAt(x,y,z);
                if (id == null) return Double.NaN;
                return switch(id.replace("minecraft:","")) {
                    case "prismarine", "stone", "coal_ore", "dirt", "grass_block", "terracotta", "orange_terracotta", "red_sand" -> .6;
                    default -> Double.NaN;
                };
            }
        };
        var route = new ArrayList<FlightSession.Waypoint>();
        for (String row: Files.readAllLines(root.resolve("approach-route.tsv"))) {
            double[] p = Arrays.stream(row.split("\\s+")).mapToDouble(Double::parseDouble).toArray();
            route.add(new FlightSession.Waypoint(p[0],p[1],p[2]));
        }
        var params = new FlightSession.Params();
        params.stopAtEnd = true;
        params.terminalReach = 1;
        var pilot = new FlightSession(route,blocks,System.currentTimeMillis()+600_000,params,0);
        var sweep = FlightSession.class.getDeclaredMethod("sweepSegmentClear",FlightDynamics.State.class,FlightDynamics.State.class);
        sweep.setAccessible(true);
        double[] m = Arrays.stream(Files.readAllLines(root.resolve(args.length>1?args[1]:"approach-state.tsv")).get(0).split("\\s+")).mapToDouble(Double::parseDouble).toArray();
        var initial = new FlightDynamics.State(m[0],m[1],m[2],m[3],m[4],m[5],(int)m[6]);
        var goal = route.get(route.size()-1);
        List<Node> beam = List.of(new Node(initial,(float)m[7],(float)m[8],null,0,0));
        Node winner = null;
        int evaluated=0;
        long begin=System.nanoTime();
        for(int tick=1;tick<=70 && winner==null && !beam.isEmpty();tick++) {
            List<Node> next = new ArrayList<>();
            for(Node n:beam) {
                float bearing=(float)(Math.toDegrees(Math.atan2(goal.z()-n.s.z,goal.x()-n.s.x))-90);
                for(float offset:new float[]{0,-15,15,-30,30}) for(float rawPitch:new float[]{-30,-12,0,12,30}) {
                    float yaw=FlightSession.limitYaw(n.yaw,bearing+offset,25);
                    float pitch=FlightSession.limitPitch(n.pitch,rawPitch,8);
                    var s=FlightDynamics.step(n.s,new FlightDynamics.Input(yaw,pitch,false));
                    evaluated++;
                    if(!(boolean)sweep.invoke(pilot,n.s,s)) continue;
                    double d=distance(s,goal), speed=Math.hypot(s.vx,s.vz);
                    double score=d+Math.abs(s.y-goal.y())+Double.parseDouble(System.getProperty("speedWeight","2"))*speed;
                    Node child=new Node(s,yaw,pitch,n,tick,score);
                    if(d<=1) {
                        var ending=pilot.recoveryFrame(s.x,s.y,s.z,s.vx,s.vy,s.vz,s.rocketTicksRemaining,0,yaw,pitch,yaw,8,14);
                        if(ending.landingContact && ending.verified>0) { winner=child;break; }
                    }
                    next.add(child);
                }
                if(winner!=null) break;
            }
            next.sort(Comparator.comparingDouble(Node::score));
            Set<String> cells=new HashSet<>();
            List<Node> distinct=new ArrayList<>();
            for(Node n:next) {
                String key=Math.round(n.s.x*2)+":"+Math.round(n.s.y*4)+":"+Math.round(n.s.z*2)+":"+Math.round(n.s.vx*8)+":"+Math.round(n.s.vy*16)+":"+Math.round(n.s.vz*8)+":"+Math.round(n.yaw/15)+":"+Math.round(n.pitch/8);
                if(cells.add(key)) distinct.add(n);
                if(distinct.size()>=Integer.getInteger("beamWidth",160)) break;
            }
            beam=distinct;
        }
        System.out.printf(Locale.ROOT,"found=%s evaluated=%d elapsedMs=%.1f%n",winner!=null,evaluated,(System.nanoTime()-begin)/1e6);
        if(winner!=null) {
            var path=new ArrayList<Node>();
            for(Node n=winner;n!=null;n=n.parent) path.add(n);
            Collections.reverse(path);
            for(Node n:path) System.out.printf(Locale.ROOT,"%d\t%.6f\t%.6f\t%.6f\t%.6f\t%.6f\t%.6f\t%.3f\t%.3f%n",n.tick,n.s.x,n.s.y,n.s.z,n.s.vx,n.s.vy,n.s.vz,n.yaw,n.pitch);
        }
    }
}
