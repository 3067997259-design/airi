import dev.mcpfabric.client.flight.*;
import java.nio.file.*;
import java.util.*;
/** Compare measured entries and explicit counterfactuals with the same planner.
 * Call stack: main -> snapshot reader -> FlightPlanner.search -> swept landing.
 * Modified entries are hypothetical and never count as physical flight evidence.
 */
public final class EntryReplay {
 public static void main(String[] args)throws Exception {
  Path root=Path.of(args[0]);
  var read=TerminalReplay.class.getDeclaredMethod("readWorld",Path.class);read.setAccessible(true);
  var raw=(FlightSession.BlockQuery)read.invoke(null,root.resolve("../elytra-landing-20260926"));
  var world=new FlightSession.BlockQuery(){
   public String idAt(double x,double y,double z){
    String id=raw.idAt(x,y,z);
    if ((Math.floor(x)==-868&&Math.floor(y)==69&&Math.floor(z)==-233&&"minecraft:dead_bush".equals(id)) || (Math.floor(x)==-851&&Math.floor(y)==68&&Math.floor(z)==-260&&"minecraft:wall_torch".equals(id)))return "air";
    return id;
   }
   public double frictionAt(double x,double y,double z){String id=idAt(x,y,z);return id!=null && Set.of("minecraft:stone","minecraft:prismarine","minecraft:coal_ore").contains(id) ? .6 : Double.NaN;}
  };
  var route=Files.readAllLines(root.resolve("route.tsv")).stream().map(l->{var v=Arrays.stream(l.split("\\s+")).mapToDouble(Double::parseDouble).toArray();return new FlightSession.Waypoint(v[0],v[1],v[2]);}).toList();
  for(String line:Files.readAllLines(root.resolve(args.length > 1 ? args[1] : "entry-counterfactual.tsv"))){
   var c=line.split("\\s+");double[] v=Arrays.stream(c).skip(1).mapToDouble(Double::parseDouble).toArray();
   var origin=new FlightSequence.Origin(new FlightDynamics.State(v[0],v[1],v[2],v[3],v[4],v[5],(int)v[6]),(float)v[7],(float)v[8]);
   if(args.length > 2 && args[2].equals("decisions")) {
    for(int horizon:new int[]{12,16,20}) for(int rockets:new int[]{0,64}) {
     var p=new FlightSession.Params();p.stopAtEnd=true;p.terminalPlanning=true;p.terminalReach=1;p.simBudgetMs=1000;p.horizonTicks=horizon;
     var flight=new FlightSession(route,world,System.currentTimeMillis()+60000,p,0);
     var cursor=FlightSession.class.getDeclaredField("entryIndex");cursor.setAccessible(true);cursor.setInt(flight,Integer.parseInt(args[3]));
     if(args.length > 4) {
      var owned=FlightSession.class.getDeclaredField("planning");owned.setAccessible(true);var planner=owned.get(flight);
      var before=planner.getClass().getDeclaredMethod("beforeTick",FlightSequence.Origin.class,long.class,long.class);before.setAccessible(true);
      for(int i=0;i<200;i++)before.invoke(planner,origin,0L,System.nanoTime()+100_000_000L);
     }
     var d=flight.tick(v[0],v[1],v[2],v[3],v[4],v[5],(float)v[7],(float)v[8],rockets,(int)v[6],0,false);
     System.out.printf(Locale.ROOT,"%s horizon=%d rockets=%d applicable=%s policy=%s end=%d/%s planning=%s note=%s%n",c[0],horizon,rockets,d.applicable,d.chosenPolicy,d.predictedEndTicks,d.predictedEndReason,d.planningState,d.note);
     if(horizon<=16 && rockets==0 && d.applicable) {
      var method=Arrays.stream(FlightSession.class.getDeclaredMethods()).filter(m->m.getName().equals("evaluate")&&m.getParameterCount()==15).findFirst().orElseThrow();method.setAccessible(true);
      for(float offset:p.yawOffsets) for(var policy:method.getParameterTypes()[1].getEnumConstants()) {
      var candidate=method.invoke(flight,offset,policy,false,v[0],v[1],v[2],v[3],v[4],v[5],(int)v[6],0,0L,69.5,(float)v[7],(float)v[8]);
      if(candidate==null)continue;
      var field=candidate.getClass().getDeclaredField("controls");field.setAccessible(true);
      @SuppressWarnings("unchecked") var inputs=(List<FlightDynamics.Input>)field.get(candidate);
      for(int lead:new int[]{6,8,12}) {
      var prefix=inputs.subList(0,lead);var future=origin;
      for(var input:prefix)future=new FlightSequence.Origin(FlightDynamics.step(future.state(),input),input.yaw,input.pitch);
      var check=FlightSession.class.getDeclaredMethod("planningPrefixClear",FlightSequence.Origin.class,List.class,long.class);check.setAccessible(true);
      var clear=check.invoke(flight,origin,prefix,System.nanoTime()+100_000_000L);
      var result=FlightPlanner.search("prefix",1,lead,"fixed-world",future,route,world,1500);
      System.out.printf(Locale.ROOT,"prefix%d %s:%s clear=%s future=(%.3f,%.3f,%.3f) hs=%.3f planner=%s rollouts=%d ms=%d%n",lead,offset,policy,clear,future.state().x,future.state().y,future.state().z,Math.hypot(future.state().vx,future.state().vz),result.reason(),result.rollouts(),result.elapsedMs());
      }
      }
     }
    }
    continue;
   }
   var result=FlightPlanner.search("entry",1,0,"fixed-world",origin,route,world,1500);
   System.out.printf(Locale.ROOT,"%s y=%.3f hs=%.3f result=%s rollouts=%d ms=%d%n",c[0],v[1],Math.hypot(v[3],v[5]),result.reason(),result.rollouts(),result.elapsedMs());
  }
 }
}
