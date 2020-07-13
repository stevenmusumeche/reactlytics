import { APIGatewayProxyHandler } from "aws-lambda";
import "source-map-support/register";
import { startOfDay, format } from "date-fns";
import { DynamoDB } from "aws-sdk";
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

function verify(body: { challenge: string }) {
  return {
    statusCode: 200,
    body: JSON.stringify({
      challenge: body.challenge,
    }),
  };
}

async function handleReactionAdded(payload: ReactionAdded) {
  const ts = makeTimestamp(payload);
  const pk = format(ts, "yyyy-MM-dd");
  const sk = payload.event.reaction;
  try {
    await client
      .put({
        Item: {
          pk,
          sk,
          reactionCount: 1,
          userCounts: {
            [payload.event.user]: 1,
          },
          updatedAt: new Date().toISOString(),
        },
        TableName: process.env.DATABASE_TABLE_NAME,
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: {
          "#pk": "pk",
        },
      })
      .promise();
  } catch (e) {
    if (e.code !== "ConditionalCheckFailedException") throw e;

    await client
      .update({
        Key: { pk, sk },
        TableName: process.env.DATABASE_TABLE_NAME,
        UpdateExpression:
          "SET #reactionCount = #reactionCount + :i, userCounts.#userId = if_not_exists(userCounts.#userId, :z) + :i, updatedAt = :now",
        ExpressionAttributeNames: {
          "#reactionCount": "reactionCount",
          "#userId": payload.event.user,
        },
        ExpressionAttributeValues: {
          ":i": 1,
          ":z": 0,
          ":now": new Date().toISOString(),
        },
      })
      .promise();
  }

  return {
    statusCode: 200,
    body: "ok",
  };
}

async function handleReactionRemoved(payload: ReactionRemoved) {
  try {
    const ts = makeTimestamp(payload);
    const pk = format(ts, "yyyy-MM-dd");
    const sk = payload.event.reaction;
    await client
      .update({
        Key: { pk, sk },
        TableName: process.env.DATABASE_TABLE_NAME,
        ConditionExpression:
          "attribute_exists(#pk) AND attribute_exists(userCounts.#userId) AND userCounts.#userId > :zero",
        UpdateExpression:
          "SET #reactionCount = #reactionCount - :i, userCounts.#userId = if_not_exists(userCounts.#userId, :d) - :i, updatedAt = :now",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#reactionCount": "reactionCount",
          "#userId": payload.event.user,
        },
        ExpressionAttributeValues: {
          ":i": 1,
          ":d": 1,
          ":zero": 0,
          ":now": new Date().toISOString(),
        },
      })
      .promise();
  } catch (e) {
    if (e.code !== "ConditionalCheckFailedException") throw e;
  }
  return {
    statusCode: 200,
    body: "ok",
  };
}

function makeTimestamp(payload: Reaction) {
  return startOfDay(new Date(Math.round(+payload.event.event_ts * 1000)));
}

// const foo = {
//   token: "KcNQ3BZYqnPfen2iXSjhKNwc",
//   team_id: "T02913TEC",
//   api_app_id: "A016J5BH9LP",
//   event: {
//     type: "reaction_added",
//     user: "U6XA0B9S7",
//     item: { type: "message", channel: "CDRTNR09K", ts: "1594649800.000900" },
//     reaction: "why-tho",
//     event_ts: "1594650416.001000",
//   },
//   type: "event_callback",
//   event_id: "Ev017CGGG1TK",
//   event_time: 1594650416,
//   authed_users: ["U016S5VJ6K0"],
// };

interface ReactionEvent {
  type: string;
  user: string;
  item: {
    type: string;
    channel: string;
    ts: string;
  };
  reaction: string;
  event_ts: string;
}

interface ReactionAddedEvent extends ReactionEvent {
  type: "reaction_added";
}

interface ReactionRemovedEvent extends ReactionEvent {
  type: "reaction_removed";
}

interface Reaction {
  token: string;
  team_id: string;
  api_app_id: string;
  event: ReactionEvent;
  type: string;
  event_id: string;
  event_time: number;
  authed_users: string[];
}

interface ReactionAdded extends Reaction {
  event: ReactionAddedEvent;
}

interface ReactionRemoved extends Reaction {
  event: ReactionRemovedEvent;
}

/**
 * popular reactions within date range
 * popular reactions by userId within date range
 * popular reactions by channelId within date range
 *
 * pk = reaction-{REACTION_ID}
 * sk = timestamp at start of day [GSI]
 * count (increment per event)
 * userId
 * channelId
 *
 *
 * pk - reactions-DATE
 * sk - reaction-{REACTION_ID}
 * count (increment per event)
 * userId
 * channelId
 *
 * PK: {TIMESTAMP AT START OF DAY}
 * SK: {REACTION_ID}
 * reactionCount (increment per event)
 * userCounts: Map(userId: count [incremented per event])
 */
