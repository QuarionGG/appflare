import { describe, expect, it } from "vitest";
import { CloudflareApiError } from "./errors";
import { makeFakeFetch } from "./fake-fetch";
import { CloudflareGraphQLError, createGraphQL } from "./graphql";
import { createHttpApi } from "./http";

const TOKEN = "cf-token-DO-NOT-LEAK-123";

function make(envelope: unknown, status = 200) {
  const fake = makeFakeFetch({ envelope, status });
  const http = createHttpApi({ accountId: "acc-123", token: TOKEN, fetch: fake.fetch });
  return { fake, gql: createGraphQL(http) };
}

describe("graphql", () => {
  it("POSTs the query and variables to /graphql and returns data", async () => {
    const { fake, gql } = make({ data: { viewer: { ok: 1 } }, errors: null });
    expect(await gql.query("query { viewer { ok } }", { a: 1 })).toEqual({ viewer: { ok: 1 } });
    const call = fake.last();
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(await call.request.json()).toEqual({
      query: "query { viewer { ok } }",
      variables: { a: 1 },
    });
  });

  it("throws CloudflareGraphQLError for errors, which Cloudflare sends with HTTP 200", async () => {
    // The shape of a real refusal of a range wider than the dataset allows.
    const { gql } = make({
      data: null,
      errors: [
        {
          message: 'account "x" cannot request a time range wider than 4w4d',
          path: ["viewer", "accounts", "0", "d1AnalyticsAdaptiveGroups"],
          extensions: { code: "quota", timestamp: "2026-10-12T10:43:21Z" },
        },
        { message: 'unknown field "nope"', path: null, extensions: {} },
      ],
    });
    const error = await gql.query("q", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareGraphQLError);
    const gqlError = error as CloudflareGraphQLError;
    expect(gqlError.codes).toEqual(["quota"]);
    expect(gqlError.errors).toHaveLength(2);
    expect(gqlError.message).toContain("cannot request a time range wider");
    expect(gqlError.message).toContain('unknown field "nope"');
    expect(gqlError.message).not.toContain(TOKEN);
  });

  it("throws when the answer has no data", async () => {
    const { gql } = make({ data: null });
    await expect(gql.query("q", {})).rejects.toBeInstanceOf(CloudflareGraphQLError);
  });

  it("reports a refused credential as a CloudflareApiError (REST envelope, HTTP 400)", async () => {
    const { gql } = make(
      {
        success: false,
        errors: [{ code: 9106, message: "Authentication failed (status: 400)" }],
        messages: [],
        result: null,
      },
      400,
    );
    const error = await gql.query("q", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).errors[0]?.code).toBe(9106);
  });
});
