package dev.mcpfabric.client.flight;
import java.util.*;
public class ApproachProbe {
 public static void main(String[] args){
  var p=new FlightSession.Params();p.stopAtEnd=true;p.terminalPlanning=true;p.terminalReach=1;p.simBudgetMs=1000;
  FlightSession.BlockQuery world=(x,y,z)-> y<60 || (z>=25&&z<28&&y<75)?"stone":"air";
  var route=List.of(new FlightSession.Waypoint(0,70,0),new FlightSession.Waypoint(0,76,30),new FlightSession.Waypoint(0,66.5,60));
  var s=new FlightSession(route,world,System.currentTimeMillis()+60000,p,0);
  try{var d=s.tick(0,70,0,0,0,1,0,0,64,0,0,false);System.out.println("fire="+d.fireRocket+" applicable="+d.applicable+" policy="+d.chosenPolicy+" ticks="+d.predictedEndTicks+" note="+d.note);}finally{s.closePlanning();}
 }
}
