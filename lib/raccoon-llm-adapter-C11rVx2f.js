import { a as raccoonRoster, n as RACCOON_PROVIDER_ID, r as buildRaccoonDescriptors, t as RACCOON_DISPLAY_NAME } from "./raccoon-models-BPD5me76.js";
import { t as assemblePiAiAdapter } from "./llm-adapter-core-lNpsJpK3.js";

//#region src/host/raccoon-llm-adapter.ts
/**
* The peer-dependent half of the directly-registered Raccoon provider —
* "second upstream provider" (ROADMAP §6.1).
*
* Mirrors `llm-adapter.ts`'s shape: ONE `PiAiAdapter` carrying ONE profile
* (`sensenova-raccoon` → `https://xiaohuanxiong.com/api/web/llm/v2`), an
* INERT pi-ai auth plane (the Raccoon JWT is resolved per request from the
* plugin's own credential store, pi-ai never manufactures it), both IMAGE
* hooks wired (a vision model that receives an image answers
* `UNSUPPORTED_CONTENT` otherwise), and no token baked into the profile —
* the picker advertises models without one and a request fails at resolve
* time, where the panel status is visible.
*
* The descriptor mapping lives in the peer-free `raccoon-models.ts`, and the
* runtime assembly is shared with the Token Plan adapter
* (`llm-adapter-core.ts`); this module is exercised by the wiring/e2e checks,
* exactly as `llm-adapter.ts` is.
*
* @module dsh-connect-sensenova-token-plan/raccoon-llm-adapter
*/
/**
* The Raccoon gateway caps one request body at ~10 MB (`HTTP_413`), so the
* per-image byte ceiling is the binding constraint; the pixel budget is
* lowered from the `dsh-llm-pi-ai` default to keep an image inside it.
*/
const RACCOON_REQUEST_IMAGE_PIXEL_BUDGET = 64e4;
/**
* Assemble the Raccoon adapter for one credential/catalogue snapshot.
*
* A fresh instance per rebuild is deliberate: `PiAiAdapter` memoizes the
* profiles snapshot internally, so the caller REPLACES the registered
* adapter when the credential or catalogue changes and emits
* `llm/adapters-updated`.
* @param {object} options - wiring.
* @param {object[]} [options.rows] - the Raccoon roster rows (`raccoonRoster`).
* @param {object} [options.officeIdentity] - the credential's `office_identity`
*   (`""` for a personal account) — feeds the per-request headers.
* @param {() => Promise<string>} options.resolveToken - resolves the live Raccoon
*   JWT per request (refreshes inside the expiry window first).
* @param {(service: string) => unknown} [options.get] - service resolver for
*   the image hooks (`attachments`, `fs`).
* @returns {{adapter: object, providerIds: string[]}} the adapter and the ids
*   it owns.
*/
function createRaccoonAdapter({ rows, officeIdentity = "", resolveToken, get }) {
	const models = buildRaccoonDescriptors(rows ?? raccoonRoster(null), { officeIdentity });
	return assemblePiAiAdapter({
		providerId: RACCOON_PROVIDER_ID,
		displayName: RACCOON_DISPLAY_NAME,
		apiKeyName: "Raccoon access token",
		models,
		resolveCredential: resolveToken,
		...get !== void 0 ? { get } : {},
		requestImagePixelBudget: RACCOON_REQUEST_IMAGE_PIXEL_BUDGET
	});
}

//#endregion
export { createRaccoonAdapter };