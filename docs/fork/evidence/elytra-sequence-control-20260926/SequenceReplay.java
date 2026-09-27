import dev.mcpfabric.client.flight.*;
import java.nio.file.*;
import java.util.*;

/** Native-session replay on a saved world. It never connects to Minecraft.
 * Call stack: main -> FlightSession.tick -> sequence suffix and landing checks.
 */
public final class SequenceReplay {
    static FlightSequence.Origin origin;
    static List<FlightDynamics.Input> controls;
    static FlightSession.BlockQuery world;
    static FlightSession session(FlightSession.BlockQuery blocks) {
        var p=new FlightSession.Params();p.stopAtEnd=true;p.terminalReach=1;
        var s=origin.state();
        var session=new FlightSession(List.of(new FlightSession.Waypoint(s.x,s.y,s.z),new FlightSession.Waypoint(-842.5,66.5,-265.5)),blocks,System.currentTimeMillis()+120000,p,0);
        session.setRouteIdentity("replay",1);
        return session;
    }
    static FlightSequence.Plan plan(String id,long revision,long tick) {
        return new FlightSequence.Plan(id,revision,tick,"landing-snapshot-20260926",origin,controls);
    }
    static FlightSession.Decision tick(FlightSession session, FlightSequence.Origin f,long tick) {
        var s=f.state();return session.tick(s.x,s.y,s.z,s.vx,s.vy,s.vz,f.yaw(),f.pitch(),0,s.rocketTicksRemaining,tick,false);
    }
    static void require(boolean pass,String detail) {if(!pass) throw new AssertionError(detail);}
    public static void main(String[] args) throws Exception {
        Path root=Path.of(args[0]);
        var read=TerminalReplay.class.getDeclaredMethod("readWorld",Path.class);read.setAccessible(true);
        var raw=(FlightSession.BlockQuery)read.invoke(null,root.resolve("../elytra-landing-20260926"));
        world=new FlightSession.BlockQuery() {
            public String idAt(double x,double y,double z) {return raw.idAt(x,y,z);}
            public double frictionAt(double x,double y,double z) {
                String id=idAt(x,y,z);
                return id!=null && Set.of("minecraft:prismarine","minecraft:stone","minecraft:coal_ore").contains(id)? .6:Double.NaN;
            }
        };
        controls=new ArrayList<>();
        for(String line:Files.readAllLines(root.resolve("../elytra-approach-20260926/shooting-06-robust.txt"))) {
            if(line.startsWith("found="))continue;
            double[] v=Arrays.stream(line.split("\\s+")).mapToDouble(Double::parseDouble).toArray();
            if(origin==null) origin=new FlightSequence.Origin(new FlightDynamics.State(v[1],v[2],v[3],v[4],v[5],v[6],0),(float)v[7],(float)v[8]);
            else controls.add(new FlightDynamics.Input((float)v[7],(float)v[8],false));
        }
        var wrong=session(world);
        require(!wrong.offerTerminalSequence(plan("other",1,0)),"wrong route accepted");
        require(!wrong.offerTerminalSequence(plan("replay",2,0)),"wrong revision accepted");
        var late=session(world);require(late.offerTerminalSequence(plan("replay",1,0)),"queue failed");
        tick(late,origin,1);require(late.terminalSequenceStatus().equals("rejected:late"),"late plan adopted");
        var far=session(world);far.offerTerminalSequence(plan("replay",1,0));
        var o=origin.state();
        var displaced=new FlightSequence.Origin(new FlightDynamics.State(o.x+.2,o.y,o.z,o.vx,o.vy,o.vz,0),origin.yaw(),origin.pitch());
        tick(far,displaced,0);require(far.terminalSequenceStatus().equals("rejected:origin"),"bad origin adopted");
        System.out.println("contracts=4/4");
        int injectTick=Integer.getInteger("injectTick",-1);
        String label=System.getProperty("label","session");
        int passed=0;long maxNs=0;int failed=0;int repairs=0;
        List<String> trajectory=new ArrayList<>();
        for(int test=-1;test<64;test++) {
            var pilot=session(world);pilot.offerTerminalSequence(plan("replay",1,0));
            double[] v={o.x,o.y,o.z,o.vx,o.vy,o.vz};
            if(test>=0 && injectTick<0) for(int axis=0;axis<6;axis++) v[axis]+=((test&(1<<axis))==0?-1:1)*(axis<3?.05:.02);
            var frame=new FlightSequence.Origin(new FlightDynamics.State(v[0],v[1],v[2],v[3],v[4],v[5],0),origin.yaw(),origin.pitch());
            boolean landed=false;String reason="time_limit";int corrected=0;
            for(int t=0;t<52;t++) {
                if(test>=0 && t==injectTick) {
                    var s=frame.state();double[] measured={s.x,s.y,s.z,s.vx,s.vy,s.vz};
                    for(int axis=0;axis<6;axis++) measured[axis]+=((test&(1<<axis))==0?-1:1)*(axis<3?.05:.02);
                    frame=new FlightSequence.Origin(new FlightDynamics.State(measured[0],measured[1],measured[2],measured[3],measured[4],measured[5],0),frame.yaw(),frame.pitch());
                }
                long started=System.nanoTime();var decision=tick(pilot,frame,t);long elapsed=System.nanoTime()-started;
                maxNs=Math.max(maxNs,elapsed);
                String status=pilot.terminalSequenceStatus();
                if(!decision.applicable || !decision.chosenPolicy.startsWith("sequence:")) {reason=status;break;}
                require(!decision.fireRocket,"unexpected rocket");
                require(Math.abs(((decision.yaw-frame.yaw())%360+540)%360-180)<=25.001,"yaw limit");
                require(Math.abs(decision.pitch-frame.pitch())<=8.001,"pitch limit");
                if(status.equals("corrected")) corrected++;
                var next=FlightDynamics.step(frame.state(),new FlightDynamics.Input(decision.yaw,decision.pitch,false));
                trajectory.add(String.format(Locale.ROOT,"%d\t%d\t%s\t%.6f\t%.6f\t%.6f\t%.3f\t%.3f\t%.4f",test,t,status,next.x,next.y,next.z,decision.yaw,decision.pitch,elapsed/1e6));
                frame=new FlightSequence.Origin(next,decision.yaw,decision.pitch);
                if(next.y<=66) {
                    require(status.equals("landing"),"contact before landing tail");
                    // This is model contact, not a live grounded flag. The production
                    // verifier also checks support and post-contact ground runout.
                    require(Math.hypot(next.x+842.5,next.z+265.5)<=1,"contact outside goal");
                    landed=true;reason="model_contact";break;
                }
            }
            if(landed)passed++;else failed++;
            repairs+=corrected;
            System.out.printf("case=%d pass=%s repairs=%d reason=%s%n",test,landed,corrected,reason);
        }
        Files.write(root.resolve(label+"-trace.tsv"),trajectory);
        System.out.printf(Locale.ROOT,"passed=%d/65 failed=%d repairs=%d maxTickMs=%.3f%n",passed,failed,repairs,maxNs/1e6);
        if(failed>0) System.exit(1);
    }
}
