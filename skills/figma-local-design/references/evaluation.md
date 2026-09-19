# Evaluating skill behavior

Use `evals/evals.json` for behavioral evaluation of the agent. Each case contains a synthetic user prompt, an expected outcome and independently checkable expectations. It contains no real designs, credentials, project rules or saved operation IDs. Numeric IDs are stable; add new IDs rather than renumbering existing cases.

Run cases in isolated sessions with the skill available. For tool workflows, use an evaluation harness with Figma/MCP/installer/filesystem stubs that return the conditions described in the prompt and record calls. Set up the synthetic repository and selected file when required by the case. Never execute the mutation suite against a user's live Figma file or global installation. Cases without those dependencies are blocked, not passed. Negative routing cases must leave skill selection automatic rather than force-loading this skill.

Judge the transcript, actual tool calls and produced artifacts against every expectation. Reading the JSON or validating its schema is not a behavioral eval run. Record model, skill version, tool fixture configuration, per-expectation results and limitations outside the distributable. Do not claim that an automated catalog analysis or a mock plugin test proves real Figma rendering.

The repository's `npm test` checks implementation behavior and dataset/package integrity. The standalone skill ships the evaluation dataset, but not the repository's implementation test suite, browser dependencies or evaluation results. Maintaining the package and running contributor tests are separate from installing or using it.
