/**
 * Negative guard for `publish-core.ts#swapRegistration`: the rollback path.
 *
 * PITFALLS §19 says "a registration that throws AFTER the old pair was released
 * must put the previous one back, or a bad publish takes down models that were
 * already serving." The two publishers share this function precisely because it
 * is the worst place to find a divergence — it only runs once something has
 * already gone wrong. A regression that silently drops the rollback would let
 * `test/provider.test.mjs` stay green (it drives the happy path and the
 * `disposed` gate, but not the failure-after-release branch).
 *
 * What this test asserts (negative: broken behavior = red):
 *   1. Before swap: state.registered=true, state.built=A.
 *   2. Swap is called with built=B, previousBuilt=A.
 *   3. registerPair throws (simulating Host-side rejection after release(A)).
 *   4. After catch: state.registered === true, state.built === A, state.error !== null.
 *
 * If the rollback is missing: step 4 fails (registered=false, built=null).
 */
import { createPairReleaser, registerProviderPair, swapRegistration } from "../src/host/publish-core.ts";

const PROVIDER_ID = "test-rollback-guard";
const DISPLAY_NAME = "Test Rollback Guard";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL: ${name}`);
    if (detail) console.error(`  detail: ${detail}`);
  }
}

// --- Swap Registration Rollback ---
{
  let activeAdapter = null;
  let callCount = 0;
  
  // Fake llm service
  const llm = {
    registerAdapter: (providerIds, adapter) => {
      callCount += 1;
      
      if (callCount === 1) {
        // First call: register B (the new one we're trying) — throw
        throw new Error("Host rejected adapter registration");
      }
      // Second+ calls succeed (rollback to A)
      activeAdapter = adapter;
      return () => { activeAdapter = null; };
    },
    registerConfigurableProviders: () => () => {}
  };
  
  const builtA = { adapter: { id: "adapter-A" }, providerIds: [PROVIDER_ID] };
  const builtB = { adapter: { id: "adapter-B" }, providerIds: [PROVIDER_ID] };
  const identity = { providerId: PROVIDER_ID, displayName: DISPLAY_NAME };
  
  // Create a wrapper registerPair that includes identity
  const wrappedRegisterPair = (llmSvc, builtObj, target) => {
    return registerProviderPair(llmSvc, builtObj, target, identity);
  };
  
  const state = {
    registered: false,
    built: null,
    error: null,
    llmAvailable: true,
    releaseAdapter: null,
    releaseDirectory: null
  };
  
  const release = createPairReleaser(state);
  const emit = () => {};
  
  // Pre-set: adapter A was previously published
  state.registered = true;
  state.built = builtA;
  state.releaseAdapter = () => { activeAdapter = null; };
  activeAdapter = builtA.adapter;
  
  check("before swap: registered=true, built=A",
    state.registered === true && state.built === builtA,
    `registered=${state.registered}, built.id=${state.built?.adapter?.id ?? "null"}`);
  
  try {
    const result = swapRegistration({
      llm,
      built: builtB,
      previousBuilt: builtA,
      state,
      release,
      registerPair: wrappedRegisterPair,
      emit,
      onRollback: () => {}
    });
    
    check("result.ok is false", result.ok === false, JSON.stringify(result));
    check("state.error set", state.error !== null, `error=${state.error}`);
    check("rollback: registered restored", state.registered === true, `registered=${state.registered}`);
    check("rollback: built restored to A", state.built === builtA, `built.id=${state.built?.adapter?.id ?? "null"}`);
    check("rollback: llm serves A", activeAdapter?.id === "adapter-A", `active=${activeAdapter?.id ?? "null"}`);
    check("2 registerAdapter calls (B fails, then A rollback succeeds)",
      callCount === 2,
      `calls=${callCount}`);
  } catch (error) {
    check("no external throw", false, String(error));
  }
  
  release();
  check("release safe", true, "");
}

console.log(`\nprovider-rollback-guard: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
