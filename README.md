# n8n-nodes-yolfi

Connect [Yolfi](https://yolfi.com) crypto payments to n8n workflows. Create hosted checkouts and payment links, retrieve customers and subscriptions, and start a workflow when Yolfi confirms a payment.

This package contains two nodes: **Yolfi** and **Yolfi Trigger**. It uses the Yolfi API directly and has no external runtime dependencies.

## Status and installation

n8n verification is pending. Self-hosted n8n administrators can install `n8n-nodes-yolfi` from **Settings > Community Nodes**. Availability in n8n Cloud requires n8n verification. See [community node installation](https://docs.n8n.io/integrations/community-nodes/installation/).

For development, use the official n8n node CLI:

```sh
npm ci
npm run lint
npm test
npm run dev
```

The development command runs a local n8n preview. Depending on the n8n version, it may require Docker or Podman. To connect to an n8n instance you already run, see the official [node development guide](https://docs.n8n.io/connect/create-nodes/build-your-node/using-the-n8n-node-tool.md).

## Credentials

1. Sign in to [Yolfi](https://app.yolfi.com).
2. Configure receiving wallets for your organization.
3. Obtain the organization API key from **Settings > API keys**.
4. Create a **Yolfi API** credential in n8n and enter that key.
5. Test the credential. The test checks access to your organization.

Yolfi nodes send the key as a Bearer token to `https://app.yolfi.com/api`. Store it in n8n credentials; never put it in workflow fields, query strings, or shared workflow exports. The API host is fixed, and authenticated requests do not follow redirects.

## Operations

| Resource         | Operations                     |
| ---------------- | ------------------------------ |
| Checkout Session | Create, Get                    |
| Payment Link     | Create, Get, Get Many, Disable |
| Customer         | Get, Get Many                  |
| Subscription     | Get                            |

**Create Checkout Session** creates a one-time checkout for a specific order. It returns a hosted payment URL and a `ycs_...` ID. Send the final server-calculated order total as a decimal string, such as `"25.00"`. Supported pricing currencies are USD, EUR, CNY, RUB, INR, TRY, KRW, and JPY. The API determines the payment networks and assets available to the customer.

Set **Idempotency Key** to a stable order-attempt identifier of 16-200 characters, for example `n8n:checkout:order-2026-001:attempt-1`. Reuse it when retrying the same request. A reused key with different request data causes a conflict. Use a new attempt identifier only when deliberately creating a different checkout. Do not use the execution ID or a random value as an automatic retry key.

**Get Checkout Session** retrieves the session in the credential's organization and includes its linked payment status. The create operation returns `url`; retrieval does not promise a URL field.

**Create Payment Link** creates a reusable one-time payment link. Payment Link outputs include `checkoutUrl`. Link creation does not have the checkout API's idempotency guarantee; use order-specific Checkout Sessions when automatic retries could create duplicates. Recurring link creation and subscription cancellation are not included in this version.

**Get Subscription** returns the subscription status, customer details, and invoice payment records. Payment Link and Subscription outputs contain selected merchant-facing fields.

**Get Many** outputs each record separately and supports a limit or all available pages. Metadata inputs accept a JSON object with at most 20 keys containing bounded string, finite number, or boolean values. Nested objects and arrays are rejected.

Customer and payment records returned by the nodes become workflow data and may be stored in your n8n execution history. Apply the execution retention and access settings appropriate for that data.

## Payment and subscription events

Add **Yolfi Trigger**, choose your credential, and select events:

| Event                    | Meaning                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `payment.confirmed`      | Yolfi confirmed a payment                                               |
| `invoice.created`        | A payment invoice was created after the buyer selected a payment method |
| `invoice.overdue`        | A payment invoice expired without full payment                          |
| `subscription.overdue`   | A subscription renewal became overdue                                   |
| `subscription.cancelled` | A subscription was cancelled                                            |

Publishing/activating the workflow creates a dedicated native webhook endpoint in Yolfi. Deactivating it removes that trigger's endpoint. A manual test registers its own temporary endpoint. Other Yolfi webhook endpoints are left alone.

Imported workflows do not take over the original workflow's endpoint. If you change your n8n public URL, activation creates an endpoint for the new URL and leaves the old endpoint untouched. Remove the obsolete endpoint from Yolfi **Settings > Webhooks** after the migration.

Your n8n instance must advertise a publicly reachable HTTPS webhook URL. Yolfi rejects private network destinations, so `localhost` alone cannot receive production webhooks. Configure your instance's public webhook URL before activation.

The trigger verifies `X-Yolfi-Signature` using Base64 HMAC-SHA256 over the exact raw body and the endpoint-specific secret. The organization API key is not a signing secret. Signature verification cannot be disabled. The endpoint secret is kept in n8n's node static data, following the platform's trigger lifecycle; keep database backups and workflow data private. It is never emitted as workflow output.

The output is the native envelope `{ id, type, created, livemode, data }`. The affected object is directly under `data`, not `data.object`. Correlation fields can include `merchantOrderId`, `checkoutSessionId`, `invoiceId`, `subscriptionId`, and `metadata`, depending on the event.

Delivery is at least once. Before granting access, shipping goods, or changing balances, deduplicate using the signed event `id` in a durable store. A successful webhook response is an acknowledgement of receipt, not a guarantee that every downstream action succeeded. Configure n8n error workflows for downstream failures. Dashboard test events have `livemode: false` and are excluded by default; enable **Include Test Events** only for workflows intended to process them.

## Example workflows

Import the JSON files from [`examples`](./examples):

- `create-order-checkout.json`: prepare an example order and create its hosted checkout.
- `payment-confirmed-record.json`: receive a confirmed payment and prepare its correlation fields for a downstream integration.

Select your own Yolfi credential after importing. The examples contain no API keys, signing secrets, real customer records, or active workflows. Adapt the order source and add durable deduplication before fulfillment.

## Compatibility and support

The package uses n8n Nodes API version 1. See [Yolfi API documentation](https://docs.yolfi.com/en/api) and [webhook documentation](https://docs.yolfi.com/en/webhooks/webhook-details).

For API problems contact [Yolfi](https://yolfi.com). Report package issues in the [issue tracker](https://github.com/yolfipay/n8n-nodes-yolfi/issues).

## License

[MIT](./LICENSE).
