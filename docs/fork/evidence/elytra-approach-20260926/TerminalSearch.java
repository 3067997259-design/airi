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
        for (String row: Files.readAllLines(root.resolve("route.tsv"))) {
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
        boolean gate=Boolean.getBoolean("gate");
        var goal = gate ? new FlightSession.Waypoint(-851.5,69,-255.5) : route.get(route.size()-1);
        List<Node> beam = List.of(new Node(initial,(float)m[7],(float)m[8],null,0,0));
        Node winner = null;
        Node closestNode = beam.get(0);
        double nearest=Double.POSITIVE_INFINITY, arrivalSpeed=Double.POSITIVE_INFINITY;
        int arrivals=0;
        int evaluated=0;
        long begin=System.nanoTime();
        if(Boolean.getBoolean("policyProbe")) {
            policy: for(float flare:new float[]{-30,-40,-50}) for(double distanceGate:new double[]{6,8,10}) for(float turn:new float[]{-90,90}) {
                Node n=beam.get(0);
                for(int tick=1;tick<=80;tick++) {
                    double horizontal=Math.hypot(goal.x()-n.s.x,goal.z()-n.s.z);
                    float bearing=(float)(Math.toDegrees(Math.atan2(goal.z()-n.s.z,goal.x()-n.s.x))-90);
                    float aim=(float)-Math.toDegrees(Math.atan2(goal.y()-n.s.y,horizontal));
                    float yaw=FlightSession.limitYaw(n.yaw,bearing+(horizontal<4.5?turn:0),25);
                    float pitch=FlightSession.limitPitch(n.pitch,horizontal<distanceGate?flare:aim+12,8);
                    var s=FlightDynamics.step(n.s,new FlightDynamics.Input(yaw,pitch,false));
                    evaluated++;
                    if(!(boolean)sweep.invoke(pilot,n.s,s)) break;
                    n=new Node(s,yaw,pitch,n,tick,0);
                    if(distance(s,goal)<=1) {
                        var end=pilot.recoveryFrame(s.x,s.y,s.z,s.vx,s.vy,s.vz,0,0,yaw,pitch,yaw,8,14);
                        if(end.landingContact && end.verified>0) {
                            System.out.printf("policy flare=%s gate=%s turn=%s%n",flare,distanceGate,turn);
                            winner=n;break policy;
                        }
                    }
                }
            }
        }
        if(System.getProperty("brakeTrace")!=null) {
            Node parent=null;
            for(String line:Files.readAllLines(root.resolve(System.getProperty("brakeTrace")))) {
                if(line.startsWith("found=")) continue;
                double[] p=Arrays.stream(line.split("\\s+")).mapToDouble(Double::parseDouble).toArray();
                var s=new FlightDynamics.State(p[1],p[2],p[3],p[4],p[5],p[6],0);
                Node start=new Node(s,(float)p[7],(float)p[8],parent,(int)p[0],0);
                parent=start;
                if(p[0]<10) continue;
                for(float delta:new float[]{-180,-150,-120,-90,-60,60,90,120,150,180})
                    for(float pitchTarget:new float[]{-60,-30,-12,0,12,30,60}) {
                        Node n=start;
                        float heading=(float)(Math.toDegrees(Math.atan2(-s.vx,s.vz))+delta);
                        for(int step=1;step<=18;step++) {
                            float yaw=FlightSession.limitYaw(n.yaw,heading,25);
                            float pitch=FlightSession.limitPitch(n.pitch,pitchTarget,8);
                            var next=FlightDynamics.step(n.s,new FlightDynamics.Input(yaw,pitch,false));
                            evaluated++;
                            if(!(boolean)sweep.invoke(pilot,n.s,next)) break;
                            n=new Node(next,yaw,pitch,n,n.tick+1,0);
                            if(distance(next,goal)<=Double.parseDouble(System.getProperty("arrivalRadius","1"))) {
                                var end=pilot.recoveryFrame(next.x,next.y,next.z,next.vx,next.vy,next.vz,0,0,yaw,pitch,yaw,8,14);
                                if(end.landingContact && end.verified>0) {
                                    winner=n;
                                    System.out.printf("brakeStart=%s delta=%s pitch=%s endingYaw=%s endingPitch=%s%n",p[0],delta,pitchTarget,end.yaw,end.pitch);
                                    break;
                                }
                            }
                        }
                        if(winner!=null) break;
                    }
                if(winner!=null) break;
            }
        }
        for(int tick=1;tick<=100 && winner==null && !Boolean.getBoolean("policyProbe") && !beam.isEmpty();tick++) {
            List<Node> next = new ArrayList<>();
            for(Node n:beam) {
                int closest=0;
                double routeDistance=Double.POSITIVE_INFINITY;
                for(int i=0;i<route.size();i++) {
                    double d=distance(n.s,route.get(i));
                    if(d<routeDistance) { closest=i;routeDistance=d; }
                }
                var reference=distance(n.s,goal)<14 ? goal : route.get(Math.min(route.size()-1,closest+6));
                float bearing=(float)(Math.toDegrees(Math.atan2(reference.z()-n.s.z,reference.x()-n.s.x))-90);
                for(float offset:new float[]{0,-30,30,-60,60,-90,90,-120,120,180}) for(float rawPitch:new float[]{-60,-30,-12,0,12,30,60}) {
                    float yaw=FlightSession.limitYaw(n.yaw,bearing+offset,25);
                    float pitch=FlightSession.limitPitch(n.pitch,rawPitch,8);
                    var s=FlightDynamics.step(n.s,new FlightDynamics.Input(yaw,pitch,false));
                    evaluated++;
                    if(!(boolean)sweep.invoke(pilot,n.s,s)) continue;
                    double d=distance(s,goal), speed=Math.hypot(s.vx,s.vz);
                    if(Boolean.getBoolean("routeFloor")) {
                        var near=route.get(0);
                        double best=Double.POSITIVE_INFINITY;
                        for(var point:route) {
                            double horizontalDistance=Math.hypot(point.x()-s.x,point.z()-s.z);
                            if(horizontalDistance<best) { near=point;best=horizontalDistance; }
                        }
                        if(s.y<near.y()-.5) continue;
                    }
                    // Diagnostic approach gate: stay above the destination
                    // support plane until the body is over its contact patch.
                    if (Boolean.getBoolean("platformFloor") && d < 30 && s.y < goal.y() - .35) continue;
                    nearest=Math.min(nearest,d);
                    double speedWeight=Double.parseDouble(System.getProperty("speedWeight","2"));
                    if (Boolean.getBoolean("localSpeedCost")) speedWeight*=Math.exp(-d/10);
                    double score=d+Math.abs(s.y-reference.y())+speedWeight*speed;
                    Node child=new Node(s,yaw,pitch,n,tick,score);
                    if (d < distance(closestNode.s,goal)) closestNode=child;
                    if(gate && d<1.5 && speed<=.55 && Math.abs(s.vy)<=.1) { winner=child;break; }
                    if(d<=1) {
                        arrivals++;
                        arrivalSpeed=Math.min(arrivalSpeed,speed);
                        var ending=pilot.recoveryFrame(s.x,s.y,s.z,s.vx,s.vy,s.vz,s.rocketTicksRemaining,0,yaw,pitch,yaw,8,14);
                        if(ending.landingContact && ending.verified>0) { winner=child;break; }
                    }
                    next.add(child);
                }
                if(winner!=null) break;
            }
            next.sort(Comparator.comparingDouble(Node::score));
            Set<String> cells=new HashSet<>();
            Map<Integer,Integer> speedBins=new HashMap<>();
            List<Node> distinct=new ArrayList<>();
            for(Node n:next) {
                String key=Math.round(n.s.x*2)+":"+Math.round(n.s.y*4)+":"+Math.round(n.s.z*2)+":"+Math.round(n.s.vx*8)+":"+Math.round(n.s.vy*16)+":"+Math.round(n.s.vz*8)+":"+Math.round(n.yaw/15)+":"+Math.round(n.pitch/8);
                int bin=(int)(Math.hypot(n.s.vx,n.s.vz)/.2);
                if(Boolean.getBoolean("speedDiversity") && speedBins.getOrDefault(bin,0)>=20) continue;
                if(cells.add(key)) {
                    distinct.add(n);
                    speedBins.merge(bin,1,Integer::sum);
                }
                if(distinct.size()>=Integer.getInteger("beamWidth",160)) break;
            }
            beam=distinct;
        }
        System.out.printf(Locale.ROOT,"found=%s evaluated=%d elapsedMs=%.1f nearest=%.3f arrivals=%d minArrivalSpeed=%.3f%n",winner!=null,evaluated,(System.nanoTime()-begin)/1e6,nearest,arrivals,arrivalSpeed);
        {
            var path=new ArrayList<Node>();
            for(Node n=winner!=null?winner:closestNode;n!=null;n=n.parent) path.add(n);
            Collections.reverse(path);
            for(Node n:path) System.out.printf(Locale.ROOT,"%d\t%.6f\t%.6f\t%.6f\t%.6f\t%.6f\t%.6f\t%.3f\t%.3f%n",n.tick,n.s.x,n.s.y,n.s.z,n.s.vx,n.s.vy,n.s.vz,n.yaw,n.pitch);
        }
    }
}
