package dev.mcpfabric.client.flight;
import java.util.*;
public class ExpiryCellProbe {
 public static void main(String[] args)throws Exception {
  var cells=new HashSet<String>(); String[] blocked={""};
  var p=new FlightSession.Params();p.stopAtEnd=true;p.terminalReach=1;
  FlightSession.BlockQuery q=(x,y,z)->{cells.add((int)Math.floor(x)+","+(int)Math.floor(y)+","+(int)Math.floor(z));return y<60 || blocked[0].equals((int)Math.floor(x)+","+(int)Math.floor(y)+","+(int)Math.floor(z))?"stone":"air";};
  var session=new FlightSession(List.of(new FlightSession.Waypoint(0,70,0),new FlightSession.Waypoint(0,60.5,50)),q,System.currentTimeMillis()+60000,p,0);
  var method=FlightSession.class.getDeclaredMethod("planningPrefixStateClear",FlightSequence.Origin.class,List.class,long.class);method.setAccessible(true);
  var controls=Collections.nCopies(20,new FlightDynamics.Input(0,-20,false));
  var traces=new ArrayList<Set<String>>();
  for(int expiry=0;expiry<=20;expiry++){
   session.refreshSequenceGeometry();cells.clear();
   method.invoke(session,new FlightSequence.Origin(new FlightDynamics.State(0,70,0,0,-.2,.3,expiry),0,-20),controls,System.nanoTime()+100_000_000L);
   traces.add(Set.copyOf(cells));
  }
  for(int expiry=1;expiry<20;expiry++)for(String cell:traces.get(expiry)){
   int y=Integer.parseInt(cell.split(",")[1]);
   if(y>=70&&!traces.get(0).contains(cell)&&!traces.get(8).contains(cell)&&!traces.get(20).contains(cell)){blocked[0]=cell; boolean valid=true;
   for(int e:new int[]{0,8,20,expiry}) {
    session.refreshSequenceGeometry();
    boolean pass=(boolean)method.invoke(session,new FlightSequence.Origin(new FlightDynamics.State(0,70,0,0,-.2,.3,e),0,-20),controls,System.nanoTime()+100_000_000L);
    if(pass!=(e!=expiry))valid=false;
   }
   if(valid){System.out.println("expiry="+expiry+" uniqueCell="+cell);return;}
   blocked[0]="";}
  }
 }
}
