/** Serve the fixture site until killed, printing `left=` and `right=` origins for $GITHUB_OUTPUT. */
import { startFixtureSite } from "./server.ts";

const site = await startFixtureSite();
console.log(`left=${site.left}\nright=${site.right}`);
