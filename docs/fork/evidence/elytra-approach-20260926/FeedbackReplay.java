import dev.mcpfabric.client.flight.FlightDynamics;
import dev.mcpfabric.client.flight.FlightSession;
import java.nio.file.*;
import java.util.*;

/** Offline feedback counterexample replay. No client connection or game input.
 * Call stack: main -> remaining-sequence check -> swept physics -> landing check.
 */
public final class FeedbackReplay {
    record Frame(FlightDynamics.State state, float yaw, float pitch) {}
    static java.lang.reflect.Method sweep;
    static FlightSession pilot;
    static List<Frame> base;
    static int checks;
    static List<Frame> verify(Frame from, int start, float dyaw, float dpitch) throws Exception {
        checks++;
        List<Frame> result = new ArrayList<>();
        Frame frame = from;
        for (int i=start; i<base.size(); i++) {
            Frame action = base.get(i);
            float weight = Math.max(0, 1 - (i-start)/12f);
            float yaw = FlightSession.limitYaw(frame.yaw, action.yaw + dyaw*weight, 25);
            float pitch = FlightSession.limitPitch(frame.pitch, action.pitch + dpitch*weight, 8);
            var next = FlightDynamics.step(frame.state, new FlightDynamics.Input(yaw,pitch,false));
            if (!(boolean)sweep.invoke(pilot,frame.state,next)) return null;
            frame = new Frame(next,yaw,pitch);
            result.add(frame);
        }
        var s = frame.state;
        if (Math.sqrt(Math.pow(s.x+842.5,2)+Math.pow(s.y-66.5,2)+Math.pow(s.z+265.5,2))>1) return null;
        var end = pilot.recoveryFrame(s.x,s.y,s.z,s.vx,s.vy,s.vz,0,0,frame.yaw,frame.pitch,frame.yaw,8,14);
        return end.verified>0 && end.landingContact ? result : null;
    }
    public static void main(String[] args) throws Exception {
        Path root=Path.of(args[0]);
        var read=TerminalReplay.class.getDeclaredMethod("readWorld",Path.class);
        read.setAccessible(true);
        var raw=(FlightSession.BlockQuery)read.invoke(null,root.resolve("../elytra-landing-20260926"));
        FlightSession.BlockQuery world=new FlightSession.BlockQuery() {
            public String idAt(double x,double y,double z) {return raw.idAt(x,y,z);}
            public double frictionAt(double x,double y,double z) {
                String id=idAt(x,y,z);
                return id!=null && Set.of("minecraft:prismarine","minecraft:stone","minecraft:coal_ore").contains(id)? .6:Double.NaN;
            }
        };
        List<Frame> original=new ArrayList<>();
        for(String line:Files.readAllLines(root.resolve("shooting-06-robust.txt"))) {
            if(line.startsWith("found=")) continue;
            double[] v=Arrays.stream(line.split("\\s+")).mapToDouble(Double::parseDouble).toArray();
            original.add(new Frame(new FlightDynamics.State(v[1],v[2],v[3],v[4],v[5],v[6],0),(float)v[7],(float)v[8]));
        }
        pilot=new FlightSession(List.of(new FlightSession.Waypoint(-851,69,-256),new FlightSession.Waypoint(-842.5,66.5,-265.5)),world,System.currentTimeMillis()+60000,new FlightSession.Params(),0);
        sweep=FlightSession.class.getDeclaredMethod("sweepSegmentClear",FlightDynamics.State.class,FlightDynamics.State.class);
        sweep.setAccessible(true);
        int passed=0, openPassed=0;
        long started=System.nanoTime();
        for(int test=0;test<64;test++) {
            base=new ArrayList<>(original);
            Frame first=base.get(0);var s=first.state;
            double[] v={s.x,s.y,s.z,s.vx,s.vy,s.vz};
            for(int axis=0;axis<6;axis++) v[axis]+=((test&(1<<axis))==0?-1:1)*(axis<3?.05:.02);
            Frame frame=new Frame(new FlightDynamics.State(v[0],v[1],v[2],v[3],v[4],v[5],0),first.yaw,first.pitch);
            boolean open=verify(frame,1,0,0)!=null;
            if(open) openPassed++;
            boolean ok=true;int corrected=0, failed=-1;
            int before=checks;
            for(int tick=1;tick<base.size();tick++) {
                List<Frame> result=verify(frame,tick,0,0);
                if(result==null) {
                    search: for(float yaw:new float[]{0,-1,1,-2,2,-4,4,-8,8})
                        for(float pitch:new float[]{0,-1,1,-2,2,-4,4,-8,8}) {
                            if(yaw==0 && pitch==0) continue;
                            result=verify(frame,tick,yaw,pitch);
                            if(result!=null) {corrected++;break search;}
                        }
                }
                if(result==null) {ok=false;failed=tick;break;}
                for(int i=0;i<result.size();i++) base.set(tick+i,result.get(i));
                frame=result.get(0);
            }
            if(ok) passed++;
            System.out.printf("case=%d open=%s closed=%s repairs=%d failedAt=%d checks=%d%n",test,open,ok,corrected,failed,checks-before);
        }
        System.out.printf(Locale.ROOT,"open=%d/64 closed=%d/64 elapsedMs=%.1f%n",openPassed,passed,(System.nanoTime()-started)/1e6);
    }
}
