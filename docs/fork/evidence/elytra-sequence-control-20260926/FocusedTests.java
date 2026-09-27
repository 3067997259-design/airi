import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;
import org.junit.platform.launcher.listeners.SummaryGeneratingListener;
import static org.junit.platform.engine.discovery.DiscoverySelectors.selectClass;
import static org.junit.platform.engine.discovery.DiscoverySelectors.selectMethod;

/** Small direct JUnit runner; no Gradle daemon or game client.
 * Call stack: main -> JUnit launcher -> selected flight regression classes.
 */
public final class FocusedTests {
    public static void main(String[] args) {
        var request=LauncherDiscoveryRequestBuilder.request();
        for(String name:args) {
            String full="dev.mcpfabric.client.flight."+name;
            request.selectors(name.contains("#") ? selectMethod(full) : selectClass(full));
        }
        var listener=new SummaryGeneratingListener();
        var launcher=LauncherFactory.create();launcher.registerTestExecutionListeners(listener);
        launcher.execute(request.build());
        var out=new java.io.PrintWriter(System.out,true);
        listener.getSummary().printTo(out);listener.getSummary().printFailuresTo(out);
        if(listener.getSummary().getTestsFailedCount()>0) System.exit(1);
    }
}
