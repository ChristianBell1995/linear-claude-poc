/**
 * Setup helper: prints your Linear user id, your teams, and any labels already
 * matching the configured names.
 *
 * Deliberately does not import config.ts, because the whole point is to find the
 * LINEAR_ACTOR_ID value that config.ts requires.
 *
 *   LINEAR_API_KEY=lin_api_... node --experimental-strip-types src/whoami.ts
 */
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) {
  console.error("Set LINEAR_API_KEY first.");
  process.exit(1);
}

const res = await fetch("https://api.linear.app/graphql", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: apiKey },
  body: JSON.stringify({
    query: `query Whoami {
      viewer { id name email }
      teams(first: 50) { nodes { id key name } }
      issueLabels(first: 250) { nodes { id name team { key } } }
    }`,
  }),
  signal: AbortSignal.timeout(15_000),
});

const payload = (await res.json()) as {
  data?: {
    viewer: { id: string; name: string; email: string };
    teams: { nodes: Array<{ id: string; key: string; name: string }> };
    issueLabels: { nodes: Array<{ id: string; name: string; team: { key: string } | null }> };
  };
  errors?: Array<{ message: string }>;
};

if (payload.errors?.length) {
  console.error(`Linear error: ${payload.errors.map((e) => e.message).join("; ")}`);
  console.error("If this is a 401, check the key goes in the Authorization header raw, with no 'Bearer ' prefix.");
  process.exit(1);
}

const data = payload.data!;
console.log(`\nLINEAR_ACTOR_ID=${data.viewer.id}   # ${data.viewer.name} <${data.viewer.email}>\n`);

console.log("Teams:");
for (const team of data.teams.nodes) console.log(`  ${team.key.padEnd(8)} ${team.id}  ${team.name}`);

const wanted = ["claude", "claude-running", "claude-failed"];
console.log("\nLabels matching the expected names:");
const found = data.issueLabels.nodes.filter((label) => wanted.includes(label.name));
if (found.length === 0) {
  console.log(`  none — create ${wanted.join(", ")} in your team before starting the server`);
} else {
  for (const label of found) console.log(`  ${label.name.padEnd(16)} ${label.id}  team=${label.team?.key ?? "workspace"}`);
  for (const name of wanted) {
    if (!found.some((label) => label.name === name)) console.log(`  MISSING: ${name}`);
  }
}
console.log();
