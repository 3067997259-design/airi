import dev.mcpfabric.client.flight.FlightSession;
import dev.mcpfabric.client.flight.FlightDynamics;
import java.nio.file.*;
import java.util.*;
/**
 * Isolates candidate coverage at the measured ab-23 failure state.
 * The flat-water world is synthetic; this does not certify the actual river bank.
 *
 * Call stack:
 * main -> restore recorded cursor -> FlightSession.tick -> FlightDynamics.step
 */
class Ab23Probe {
  static final FlightSession.BlockQuery FLAT_RIVER=(x,y,z)->Math.floor(y)<=55?"minecraft:stone":Math.floor(y)<=62?"minecraft:water":"minecraft:air";
  public static void main(String[] args) throws Exception {
    List<FlightSession.Waypoint> route=new ArrayList<>();
    for(String row:Files.readAllLines(Path.of(args[0]))) {double[] v=Arrays.stream(row.split(",")).mapToDouble(Double::parseDouble).toArray();route.add(new FlightSession.Waypoint(v[0],v[1],v[2]));}
    double[] s=Arrays.stream(Files.readString(Path.of(args[1])).trim().split(",")).mapToDouble(Double::parseDouble).toArray();
    var target=route.get((int)s[10]);double aim=-Math.toDegrees(Math.atan2(target.y()-s[1],Math.hypot(target.x()-s[0],target.z()-s[2])));
    for(boolean level:new boolean[]{false,true}) {
      var p=new FlightSession.Params();p.entryReach=8;p.simBudgetMs=1000;
      if(level)p.pitchOffsets=new float[]{0,-12,12,-28,(float)-aim};
      var session=new FlightSession(route,FLAT_RIVER,System.currentTimeMillis()+60000,p,5000);
      // Restore the recorded cursor; do not change production code or pretend to replay missing terrain.
      var cursor=FlightSession.class.getDeclaredField("entryIndex");cursor.setAccessible(true);cursor.setInt(session,(int)s[10]);
      var result=session.tick(s[0],s[1],s[2],s[3],s[4],s[5],(float)s[6],(float)s[7],(int)s[9],(int)s[8],0,false);
      System.out.printf(Locale.ROOT,"flat-river add-level=%s applicable=%s yaw=%.6f pitch=%.6f fire=%s ticks=%d cursor=%d endCursor=%d note=%s%n",level,result.applicable,result.yaw,result.pitch,result.fireRocket,result.predictedEndTicks,result.cursor,result.predictedEndCursor,result.note);
    }
  }
}

