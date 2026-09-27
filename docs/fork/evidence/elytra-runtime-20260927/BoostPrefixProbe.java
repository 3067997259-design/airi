package dev.mcpfabric.client.flight;
import java.util.*;
public class BoostPrefixProbe {
 public static void main(String[] args) {
  var p=new FlightSession.Params();p.stopAtEnd=true;p.terminalReach=1;
  var session=new FlightSession(List.of(new FlightSession.Waypoint(0,65,0),new FlightSession.Waypoint(0,60.5,50)),(x,y,z)->y<60?"stone":"air",System.currentTimeMillis()+60000,p,0);
  for(double y:new double[]{64,64.5,65,66})for(double vy:new double[]{-.1,-.2,-.3}) {
   var controls=Collections.nCopies(20,new FlightDynamics.Input(0,-20,false));
   boolean[] pass=new boolean[2];
   for(int k=0;k<2;k++)pass[k]=session.planningPrefixClear(new FlightSequence.Origin(new FlightDynamics.State(0,y,0,0,vy,.3,k*8),0,-20),controls,System.nanoTime()+100_000_000L);
   if(!pass[0]&&pass[1])System.out.println("y="+y+" vy="+vy+" zero="+pass[0]+" nominal="+pass[1]);
  }
 }
}
