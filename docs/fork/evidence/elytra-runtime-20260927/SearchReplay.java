import dev.mcpfabric.client.flight.*;
import java.nio.file.*;
import java.util.*;

/** Offline checks of the production planner; no recorded controls are inputs.
 * Call stack: main -> FlightPlanner.search -> snapshot sweep and landing checks.
 */
public final class SearchReplay {
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
        for(String stateFile:List.of("actual-06-refusal.tsv","entry-240.tsv")) {
            double[] v=Arrays.stream(Files.readString(root.resolve("../elytra-approach-20260926/"+stateFile)).trim().split("\\s+")).mapToDouble(Double::parseDouble).toArray();
            var origin=new FlightSequence.Origin(new FlightDynamics.State(v[0],v[1],v[2],v[3],v[4],v[5],(int)v[6]),(float)v[7],(float)v[8]);
            var path=List.of(new FlightSession.Waypoint(v[0],v[1],v[2]),new FlightSession.Waypoint(-842.5,66.5,-265.5));
            var result=FlightPlanner.search("replay",1,0,"snapshot",origin,path,world,1500);
            System.out.printf("state=%s result=%s rollouts=%d ms=%d controls=%d%n",stateFile,result.reason(),result.rollouts(),result.elapsedMs(),result.plan()==null?0:result.plan().inputs().size());
            if(result.plan()!=null) {
                List<String> trace=new ArrayList<>();
                var s=origin.state();
                for(var input:result.plan().inputs()) {
                    s=FlightDynamics.step(s,input);
                    trace.add(String.format(Locale.ROOT,"%.6f\t%.6f\t%.6f\t%.6f\t%.6f\t%.6f\t%.3f\t%.3f",s.x,s.y,s.z,s.vx,s.vy,s.vz,input.yaw,input.pitch));
                }
                Files.write(root.resolve("search-"+stateFile),trace);
            }
        }
    }
}
