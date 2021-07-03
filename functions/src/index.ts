import { firestore, initializeApp } from "firebase-admin";
import * as functions from "firebase-functions";
import isUrl from "validator/lib/isURL";
import fetch, { HeaderInit } from "node-fetch";

initializeApp(functions.config().firebase);

// See README.md for setting up API_KEY
const API_KEY = functions.config().webhooks.api_key;

const WEBHOOK_ADDRESSES = {
  Mux: `/mux/hooks`,
  Stripe: `/stripe/hooks`,
} as const;

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

// HoF for validating API tokens in request
const validate = (
  fn: (req: functions.https.Request, res: functions.Response) => Promise<any>
): ((req: functions.https.Request, res: functions.Response) => Promise<void>) => {
  return async (req, res) => {
    if (API_KEY === req.query.api_key) {
      return fn(req, res);
    } else {
      res.status(401).json({ error: "api_key is not valid" });
    }
  };
};

// HoF wrapper for routing & error handling convenience
const router = (
  methods: Partial<
    Record<HttpMethod, (req: functions.https.Request, res: functions.Response) => Promise<string | Object | void>>
  >
): ((req: functions.https.Request, res: functions.Response) => Promise<void>) => {
  return async (req: functions.https.Request, res: functions.Response) => {
    try {
      if (!methods[req.method as HttpMethod])
        throw new Error(`Not a valid method for this endpoint: [${Object.keys(methods).join(", ")}]`);
      const result = await methods[req.method as HttpMethod]?.(req, res);
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  };
};

// Alias
const api = functions.https;

// GET webhooks.stageup.uk/ping
export const ping = api.onRequest(router({ GET: async (req, res) => "Pong!" }));

const checkURL = (url: string | undefined) => {
  if (!url) throw new Error("Requires 'url' query parameter to register endpoint");
  // No TLD - allow localhost:3000 etc.
  if (!isUrl(url, { require_tld: false })) throw new Error("URL provided is not a valid address");
  return url;
};

export const endpoints = api.onRequest(
  router({
    // GET POST webhooks.stageup.com/endpoints
    GET: async (req, res) => {
      const urls = await firestore().collection("endpoints").get();
      return urls.docs.map((doc) => doc.data().url);
    },
    // POST webhooks.stageup.com/endpoints?url=https://su-123.stageup.uk
    POST: validate(async (req, res) => {
      let url = checkURL(req.query.url?.toString());
      functions.logger.info(`Registering webhook url: ${url}`);

      // Don't allow duplicates because it'll cause multiple fan-outs of the same webhooks
      const urls = await firestore().collection("endpoints").where("url", "==", url).get();
      if (urls.docs.length) throw new Error(`${url} already exists`);

      // Must not end with /, because we then tack on the webhook address in the fan-out
      if (url.endsWith("/")) url = url.slice(0, -1);

      return { _id: (await firestore().collection("endpoints").add({ url: url })).id };
    }),
    // DELETE webhooks.stageup.com/endpoints?url=https://su-123.stageup.uk
    DELETE: validate(async (req, res) => {
      const url = checkURL(req.query.url?.toString());
      functions.logger.info(`Destroying webhook url: ${url}`);

      // Check if it exists before we try and delete it
      const endpoints = await firestore().collection("endpoints").where("url", "==", url).get();
      if (!endpoints.docs.length) throw new Error(`${url} does not exist`);

      await Promise.all(endpoints.docs.map((e) => e.ref.delete()));
    }),
  })
);

export const mux = api.onRequest(
  router({
    // POST webhooks.stageup.uk/mux --> fan-out to su-xxx.stageup.uk et al.
    POST: async (req, res) => {
      functions.logger.info(`Recieved MUX webhook:`, req.body);

      const { docs } = await firestore().collection("endpoints").get();

      // Setup map of [url, () => Promise<pending>]
      const promises: Array<[string, () => Promise<any>]> = docs.map((doc) => {
        const url = `${doc.data().url}${WEBHOOK_ADDRESSES.Mux}`;

        return [
          url,
          // defer execution until inside allSettled
          async () => {
            functions.logger.info(`Forwarding to ${url}`);
            return await fetch(url, {
              headers: {
                ["mux-signature"]: req.headers["mux-signature"] as string,
              },
              body: req.rawBody, // mux signature verification requires non-parsed body
              method: "POST",
              timeout: 10000, // 10 seconds
            }).catch((e) => console.log(e));
          },
        ];
      });

      // .allSettled because some endpoints could fail
      const settlements = await Promise.allSettled(promises.map(async ([k, v]) => [k, await v()]));

      settlements.forEach((settlement) => settlement.status == "rejected" && functions.logger.error(settlement.reason));

      // all the fulfilled responses
      const successfulEndpoints: string[] = settlements
        .filter((settlement) => settlement.status == "fulfilled")
        .map((settlement) => (settlement as PromiseFulfilledResult<any>).value[0]);

      // can't know what url this is because PromiseRejectedResult doesn't contain the value passed in
      // so we can do an intersection to see which URL's aren't in successful responses to see the failed ones
      const failedEndpoints: string[] = promises
        .filter(([url]) => !successfulEndpoints.includes(url))
        .map((promise) => promise[0]);

      functions.logger.info("Fanout result:", { failed: failedEndpoints, successful: successfulEndpoints });
    },
  })
);
