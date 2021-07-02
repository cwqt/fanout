import { firestore, initializeApp } from "firebase-admin";
import * as functions from "firebase-functions";
import isUrl from "validator/lib/isURL";
import fetch, { HeaderInit } from "node-fetch";

initializeApp(functions.config().firebase);

// See README.md for setting up API_KEY
const API_KEY = functions.config().webhooks.api_key;

console.log(API_KEY);

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

// Alias for setting fns in eu-west2
const api = functions.region("europe-west2").https;

// GET webhooks.stageup.uk/ping
export const ping = api.onRequest(router({ GET: async (req, res) => "Pong!" }));

const checkURL = (url: string | undefined) => {
  if (!url) throw new Error("Requires 'url' query parameter to register endpoint");
  if (!isUrl(url)) throw new Error("URL provided is not a valid address");
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
      functions.logger.info(`Registering webhook url: ${url}`, { structuredData: true });

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
      functions.logger.info(`Destroying webhook url: ${url}`, { structuredData: true });

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
      functions.logger.info(`Recieved MUX webhook: ${req.body}`, { structuredData: true });

      const { docs: endpoints } = await firestore().collection("endpoints").get();
      // .allSettled because some endpoints could fail
      await Promise.allSettled(
        endpoints.map((endpoint) => {
          fetch(`${endpoint.data().url}${WEBHOOK_ADDRESSES.Mux}`, {
            headers: req.headers as HeaderInit,
            body: req.body,
            method: "POST",
            timeout: 10000, // 10 seconds
          });
        })
      );
    },
  })
);
