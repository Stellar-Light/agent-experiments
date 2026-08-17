/** GET /api/momo/terms: Momo's current policy, signed. Fetch it before you pay; hold Momo to it. */
import { signedTerms } from "../../lib/policy.js";
import { merchantById } from "../../lib/momo.js";
export default async function handler(_req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=30");
  res.status(200).json(signedTerms(merchantById(_req.query?.merchant, _req.query?.cfg)));
}
