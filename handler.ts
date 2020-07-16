import { APIGatewayProxyHandler } from "aws-lambda";
import "source-map-support/register";
import { format, subDays } from "date-fns";
import { DynamoDB } from "aws-sdk";
import { parse } from "querystring";
import {
  handleReactionAdded,
  handleReactionRemoved,
  buildTopReactionsPayload,
  buildErrorPayload,
  buildTopReactionsForUserPayload,
  buildTopReactionsForEmojiPayload,
  buildTopUsersPayload,
  buildHelpPayload,
} from "./lib";
var dynamodb = new DynamoDB({
  maxRetries: 5,
  retryDelayOptions: { base: 300 },
});
export const client = new DynamoDB.DocumentClient({ service: dynamodb });

export const reactions: APIGatewayProxyHandler = async (event, _context) => {
  const body = JSON.parse(event.body);
  if (body.type === "url_verification") {
    return verify(body);
  }

  switch (body.event.type) {
    case "reaction_added":
      return handleReactionAdded(body);
    case "reaction_removed":
      return handleReactionRemoved(body);
  }

  console.warn("Unhandled event", event.body);
  return {
    statusCode: 200,
    body: null,
  };
};

export const report: APIGatewayProxyHandler = async (event, _context) => {
  const numDays = event?.queryStringParameters?.numDays || 7;
  const results = new Map();
  for (let i = 0; i < numDays; i++) {
    const pk = format(subDays(new Date(), i), "yyyy-MM-dd");
    const response = await client
      .query({
        TableName: process.env.DATABASE_TABLE_NAME,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": pk,
        },
        Limit: 1000,
      })
      .promise();

    response.Items.forEach((item) => {
      if (results.has(item.sk)) {
        results.set(item.sk, results.get(item.sk) + item.reactionCount);
      } else {
        results.set(item.sk, item.reactionCount);
      }
    });
  }

  const sorted = [...results.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ reaction: name, count }));

  return {
    statusCode: 200,
    body: JSON.stringify(sorted),
  };
};

export const slash: APIGatewayProxyHandler = async (event, _context) => {
  const { text } = parse(event.body) as { text: string };
  console.log(
    JSON.stringify({
      type: "Slash request received",
      raw: event.body,
      parsed: text,
    })
  );
  let body: any = buildErrorPayload();

  const userMatch = text.trim().match(/^<@(?<userId>U.*?)(\||>)/);
  const emojiMatch = text.trim().match(/^:(?<emoji>.*?):/);

  if (text.trim() === "help" || text.trim() === "") {
    body = buildHelpPayload();
  } else if (text.trim() === "emoji" || text.trim() === "emojis") {
    body = await buildTopReactionsPayload();
  } else if (text.trim() === "people" || text.trim() === "users") {
    body = await buildTopUsersPayload();
  } else if (userMatch) {
    const userId = userMatch.groups.userId;
    body = await buildTopReactionsForUserPayload(userId);
  } else if (emojiMatch) {
    const emoji = emojiMatch.groups.emoji;
    body = await buildTopReactionsForEmojiPayload(emoji);
  }

  return {
    statusCode: 200,
    body: JSON.stringify(body),
  };
};

function verify(body: { challenge: string }) {
  return {
    statusCode: 200,
    body: JSON.stringify({
      challenge: body.challenge,
    }),
  };
}
