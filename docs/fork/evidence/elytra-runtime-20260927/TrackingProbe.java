import dev.mcpfabric.client.flight.*;
import java.util.*;
public class TrackingProbe {
 public static void main(String[] args){
  for(double x:new double[]{0,1,3})for(double vx:new double[]{0,.3})for(int boost:new int[]{0,10,25}){
   var p=new FlightSession.Params();p.simBudgetMs=1000;
   var route=new ArrayList<FlightSession.Waypoint>();for(int z=0;z<=150;z++)route.add(new FlightSession.Waypoint(0,70,z));
   var s=new FlightSession(route,(a,b,c)->b<60?"stone":"air",System.currentTimeMillis()+60000,p);
   var d=s.tick(x,70,10,vx,0,1.5,0,0,64,boost,0,false);
   System.out.printf(Locale.ROOT,"x=%.1f vx=%.1f boost=%d policy=%s endY=%.4f endX=%.4f%n",x,vx,boost,d.chosenPolicy,d.predictedEndY,d.predictedEndX);
  }
 }
}
