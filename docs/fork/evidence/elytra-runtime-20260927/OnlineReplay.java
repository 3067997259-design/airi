import dev.mcpfabric.client.flight.*;
import java.nio.file.*;
import java.util.*;

/** Exercises snapshot capture, reservation and adoption at native tick cadence.
 * Call stack: main -> FlightSession.tick -> FlightPlanning -> FlightPlanner.
 * This is a model replay, not a real flight or a Minecraft collision simulation.
 */
public final class OnlineReplay {
    public static void main(String[] args) throws Exception {
        Path root=Path.of(args[0]);
        var read=TerminalReplay.class.getDeclaredMethod("readWorld",Path.class);read.setAccessible(true);
        var raw=(FlightSession.BlockQuery)read.invoke(null,root.resolve("../elytra-landing-20260926"));
        var world=new FlightSession.BlockQuery() {
            public String idAt(double x,double y,double z) {return raw.idAt(x,y,z);}
            public double frictionAt(double x,double y,double z) {
                String id=idAt(x,y,z);
                return id!=null && Set.of("minecraft:stone","minecraft:prismarine","minecraft:coal_ore").contains(id) ? .6 : Double.NaN;
            }
        };
        var route=Files.readAllLines(root.resolve("route.tsv")).stream().map(line->{
            var v=Arrays.stream(line.split("\\s+")).mapToDouble(Double::parseDouble).toArray();
            return new FlightSession.Waypoint(v[0],v[1],v[2]);
        }).toList();
        var v=Arrays.stream(Files.readString(root.resolve(args.length>2 ? args[2] : "online-origin.tsv")).trim().split("\\s+")).mapToDouble(Double::parseDouble).toArray();
        var s=new FlightDynamics.State(v[0],v[1],v[2],v[3],v[4],v[5],(int)v[6]);
        int nearest=0;double distance=Double.POSITIVE_INFINITY;
        for(int i=0;i<route.size();i++) {double d=Math.hypot(s.x-route.get(i).x(),s.z-route.get(i).z());if(d<distance){distance=d;nearest=i;}}
        route=route.subList(nearest,route.size());
        float yaw=(float)v[7],pitch=(float)v[8];
        var params=new FlightSession.Params();params.stopAtEnd=true;params.terminalReach=1;params.entryReach=6;params.terminalPlanning=true;
        // Isolate scheduling semantics first. Production-budget replay is separate.
        if(args.length>1) params.simBudgetMs=Integer.parseInt(args[1]);
        var pilot=new FlightSession(route,world,System.currentTimeMillis()+60000,params,0);pilot.setRouteIdentity("online",1);
        try {
            for(int t=0;t<240;t++) {
                long start=System.nanoTime();
                var d=pilot.tick(s.x,s.y,s.z,s.vx,s.vy,s.vz,yaw,pitch,64,s.rocketTicksRemaining,t,false);
                System.out.printf(Locale.ROOT,"%d %.3f %.3f %.3f %s %s seq=%s applicable=%s budget=%s note=%s%n",t,s.x,s.y,s.z,d.chosenPolicy,d.planningState,pilot.terminalSequenceStatus(),d.applicable,d.budgetExhausted,d.note);
                if(!d.applicable || pilot.isDone()) break;
                yaw=d.yaw;pitch=d.pitch;
                s=FlightDynamics.step(s,new FlightDynamics.Input(yaw,pitch,d.fireRocket));
                if(s.y<66 && Math.hypot(s.x+842.5,s.z+265.5)<2) {System.out.println("MODEL_CONTACT "+s.x+" "+s.y+" "+s.z);break;}
                long wait=50_000_000L-(System.nanoTime()-start);if(wait>0) Thread.sleep(wait/1_000_000L);
            }
        } finally {pilot.closePlanning();}
    }
}
