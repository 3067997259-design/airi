import dev.mcpfabric.client.flight.FlightDynamics;
import dev.mcpfabric.client.flight.FlightSession;
import java.nio.file.*;
import java.util.*;

/** Offline bounded shooting experiment, without game inputs or a trained model.
 * Call stack: main -> sampled control sequences -> native-model sweep -> landing verifier.
 * Only a fully checked sequence counts as a witness; its score alone never does.
 */
public final class ControlSequenceSearch {
    record Frame(FlightDynamics.State s,float yaw,float pitch) {}
    record Trial(double cost,double[] controls,List<Frame> path,boolean found) {}
    private static boolean robustLanding(List<Frame> path, FlightSession pilot,
            java.lang.reflect.Method sweep, FlightSession.Waypoint goal) throws Exception {
        boolean combined=Boolean.getBoolean("combinedCases");
        for(int test=0;test<(combined?64:16);test++) {
            Frame f=path.get(0);var s=f.s;
            double[] v={s.x,s.y,s.z,s.vx,s.vy,s.vz,f.yaw,f.pitch};
            if(combined) {
                for(int axis=0;axis<6;axis++) v[axis]+=((test&(1<<axis))==0?-1:1)*(axis<3?.05:.02);
            }
            else {
                int axis=test/2,sign=test%2==0?-1:1;
                v[axis]+=sign*(axis<3?.05:axis<6?.02:1);
            }
            f=new Frame(new FlightDynamics.State(v[0],v[1],v[2],v[3],v[4],v[5],s.rocketTicksRemaining),(float)v[6],(float)v[7]);
            for(int i=1;i<path.size();i++) {
                var input=path.get(i);
                float yaw=FlightSession.limitYaw(f.yaw,input.yaw,25),pitch=FlightSession.limitPitch(f.pitch,input.pitch,8);
                var next=FlightDynamics.step(f.s,new FlightDynamics.Input(yaw,pitch,false));
                if(!(boolean)sweep.invoke(pilot,f.s,next)) return false;
                f=new Frame(next,yaw,pitch);
            }
            s=f.s;
            if(Math.sqrt(Math.pow(s.x-goal.x(),2)+Math.pow(s.y-goal.y(),2)+Math.pow(s.z-goal.z(),2))>1) return false;
            var end=pilot.recoveryFrame(s.x,s.y,s.z,s.vx,s.vy,s.vz,0,0,f.yaw,f.pitch,f.yaw,8,14);
            if(!end.landingContact || end.verified<=0) return false;
        }
        return true;
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
        List<Frame> base=new ArrayList<>();
        for(String line:Files.readAllLines(root.resolve(System.getProperty("seedTrace","platform-floor-240.txt")))) {
            if(line.startsWith("found=")) continue;
            double[] v=Arrays.stream(line.split("\\s+")).mapToDouble(Double::parseDouble).toArray();
            base.add(new Frame(new FlightDynamics.State(v[1],v[2],v[3],v[4],v[5],v[6],0),(float)v[7],(float)v[8]));
        }
        if(System.getProperty("initialState")!=null) {
            double[] m=Arrays.stream(Files.readString(root.resolve(System.getProperty("initialState"))).trim().split("\\s+")).mapToDouble(Double::parseDouble).toArray();
            int nearest=0;
            double distance=Double.POSITIVE_INFINITY;
            for(int i=0;i<base.size();i++) {
                double d=Math.hypot(base.get(i).s.x-m[0],base.get(i).s.z-m[2]);
                if(d<distance) { distance=d;nearest=i; }
            }
            base=new ArrayList<>(base.subList(nearest,base.size()));
            base.set(0,new Frame(new FlightDynamics.State(m[0],m[1],m[2],m[3],m[4],m[5],(int)m[6]),(float)m[7],(float)m[8]));
        }
        var goal=new FlightSession.Waypoint(-842.5,66.5,-265.5);
        var params=new FlightSession.Params();
        params.inflate=Double.parseDouble(System.getProperty("inflate",".15"));
        var pilot=new FlightSession(List.of(new FlightSession.Waypoint(base.get(0).s.x,base.get(0).s.y,base.get(0).s.z),goal),world,System.currentTimeMillis()+60_000,params,0);
        var sweep=FlightSession.class.getDeclaredMethod("sweepSegmentClear",FlightDynamics.State.class,FlightDynamics.State.class);
        sweep.setAccessible(true);
        int steps=48,dimensions=24,rollouts=0;
        Random random=new Random(240);
        double[] mean=new double[dimensions],deviation=new double[dimensions];
        for(int i=0;i<dimensions;i++) deviation[i]=i%2==0?45:24;
        Trial best=null;
        long started=System.nanoTime();
        search: for(int generation=0;generation<16;generation++) {
            List<Trial> population=new ArrayList<>();
            for(int sample=0;sample<128;sample++) {
                rollouts++;
                double[] controls=mean.clone();
                if(sample>0) for(int i=0;i<dimensions;i++) controls[i]+=random.nextGaussian()*deviation[i];
                List<Frame> path=new ArrayList<>();
                Frame frame=base.get(0);
                path.add(frame);
                double score=Double.POSITIVE_INFINITY;
                boolean collision=false,found=false;
                for(int tick=0;tick<steps;tick++) {
                    Frame target=base.get(Math.min(tick+1,base.size()-1));
                    int block=(tick/4)*2;
                    float yaw=FlightSession.limitYaw(frame.yaw,(float)(target.yaw+controls[block]),25);
                    float pitch=FlightSession.limitPitch(frame.pitch,(float)(target.pitch+controls[block+1]),8);
                    var s=FlightDynamics.step(frame.s,new FlightDynamics.Input(yaw,pitch,false));
                    if(!(boolean)sweep.invoke(pilot,frame.s,s)) {collision=true;break;}
                    frame=new Frame(s,yaw,pitch);
                    path.add(frame);
                    double d=Math.sqrt(Math.pow(s.x-goal.x(),2)+Math.pow(s.y-goal.y(),2)+Math.pow(s.z-goal.z(),2));
                    double speed=Math.hypot(s.vx,s.vz);
                    score=Math.min(score,d+3*Math.abs(s.y-goal.y())+8*speed);
                    if(d<=1 && speed<.8) {
                        var ending=pilot.recoveryFrame(s.x,s.y,s.z,s.vx,s.vy,s.vz,0,0,yaw,pitch,yaw,8,14);
                        if(ending.landingContact && ending.verified>0) {found=true;score=-1;break;}
                    }
                }
                if(found && Boolean.getBoolean("requireRobust") && !robustLanding(path,pilot,sweep,goal)) {
                    found=false;
                    score=0;
                }
                Trial trial=new Trial(score+(collision?2:0),controls,path,found);
                population.add(trial);
                if(best==null || trial.cost<best.cost) best=trial;
                if(found) break search;
            }
            population.sort(Comparator.comparingDouble(Trial::cost));
            for(int i=0;i<dimensions;i++) {
                double average=0,variance=0;
                for(int j=0;j<12;j++) average+=population.get(j).controls[i]/12;
                for(int j=0;j<12;j++) variance+=Math.pow(population.get(j).controls[i]-average,2)/12;
                mean[i]=average;
                deviation[i]=Math.max(i%2==0?5:3,Math.sqrt(variance));
            }
        }
        System.out.printf(Locale.ROOT,"found=%s rollouts=%d elapsedMs=%.1f score=%.3f%n",best.found,rollouts,(System.nanoTime()-started)/1e6,best.cost);
        if(best.found) {
            List<String> checks=new ArrayList<>();
            for(int axis=0;axis<8;axis++) for(int sign:new int[]{-1,1}) {
                Frame f=best.path.get(0);var s=f.s;
                double[] v={s.x,s.y,s.z,s.vx,s.vy,s.vz,f.yaw,f.pitch};
                v[axis]+=sign*(axis<3?.05:axis<6?.02:1);
                f=new Frame(new FlightDynamics.State(v[0],v[1],v[2],v[3],v[4],v[5],s.rocketTicksRemaining),(float)v[6],(float)v[7]);
                boolean clear=true;int failedAt=-1;
                for(int i=1;i<best.path.size();i++) {
                    var action=best.path.get(i);
                    float yaw=FlightSession.limitYaw(f.yaw,action.yaw,25);
                    float pitch=FlightSession.limitPitch(f.pitch,action.pitch,8);
                    var next=FlightDynamics.step(f.s,new FlightDynamics.Input(yaw,pitch,false));
                    if(!(boolean)sweep.invoke(pilot,f.s,next)) {clear=false;failedAt=i;break;}
                    f=new Frame(next,yaw,pitch);
                }
                var end=pilot.recoveryFrame(f.s.x,f.s.y,f.s.z,f.s.vx,f.s.vy,f.s.vz,0,0,f.yaw,f.pitch,f.yaw,8,14);
                double error=Math.sqrt(Math.pow(f.s.x-goal.x(),2)+Math.pow(f.s.y-goal.y(),2)+Math.pow(f.s.z-goal.z(),2));
                checks.add(String.format(Locale.ROOT,"axis=%d sign=%d clear=%s failedAt=%d endDistance=%.4f landing=%s",axis,sign,clear,failedAt,error,end.landingContact && end.verified>0 && error<=1));
            }
            if(Boolean.getBoolean("combinedCases")) checks.add("combined64="+robustLanding(best.path,pilot,sweep,goal));
            Files.write(root.resolve(System.getProperty("robustReport","robustness.txt")),checks);
        }
        for(int i=0;i<best.path.size();i++) {
            var f=best.path.get(i);var s=f.s;
            System.out.printf(Locale.ROOT,"%d\t%.6f\t%.6f\t%.6f\t%.6f\t%.6f\t%.6f\t%.3f\t%.3f%n",i,s.x,s.y,s.z,s.vx,s.vy,s.vz,f.yaw,f.pitch);
        }
    }
}
