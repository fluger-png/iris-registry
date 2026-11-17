import { irisPromo, IrisPromoError } from "../src/iris-promo.js";

try {
  await irisPromo.check();
  console.log("Shopify discount scopes, lookup and customer verified. No discount created.");
} catch (error) {
  console.error(error instanceof IrisPromoError ? `${error.code}: ${error.message}` : "Shopify promo check failed.");
  process.exitCode = 1;
}
