package dev.mcpfabric.client.flight;
import java.util.*;
public class FrictionProbe {
 public static void main(String[] args){
  var reads=new HashMap<String,Integer>();
  var world=new FlightSession.BlockQuery(){
   public String idAt(double x,double y,double z){return y<66?"stone":"air";}
   public double frictionAt(double x,double y,double z){reads.merge(x+":"+y+":"+z,1,Integer::sum);return .6;}
  };
  var p=new FlightSession.Params();p.stopAtEnd=true;p.terminalReach=1;
  var s=new FlightSession(List.of(new FlightSession.Waypoint(-8,67,0),new FlightSession.Waypoint(0,66.5,0)),world,System.currentTimeMillis()+60000,p,0);
  reads.clear();s.refreshSequenceGeometry();
  var result=s.sequenceLanding(new FlightSequence.Origin(new FlightDynamics.State(0,66.8,0,.03,-.32,0,0),0,0),System.nanoTime()+100_000_000L);
  System.out.println("landing="+(result!=null)+" cells="+reads.size()+" totalReads="+reads.values().stream().mapToInt(Integer::intValue).sum()+" maxPerCell="+reads.values().stream().mapToInt(Integer::intValue).max().orElse(0));
 }
}
