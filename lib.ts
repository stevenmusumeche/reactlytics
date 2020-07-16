import { startOfDay, format, subDays } from "date-fns";
import { DynamoDB } from "aws-sdk";
var dynamodb = new DynamoDB({
  maxRetries: 5,
  retryDelayOptions: { base: 300 },
});
export const client = new DynamoDB.DocumentClient({ service: dynamodb });

const getTopReactions = async (numDays = 7) => {
  const results = new Map();
  const items = await fetchData({ numDays });
  items.forEach((item) => {
    if (results.has(item.sk)) {
      const existing = results.get(item.sk);
      results.set(item.sk, {
        count: existing.count + item.reactionCount,
        users: new Set([...existing.users, ...Object.keys(item.userCounts)]),
      });
    } else {
      results.set(item.sk, {
        count: item.reactionCount,
        users: new Set(Object.keys(item.userCounts)),
      });
    }
  });

  const sorted = [...results.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, data]) => ({
      reaction: name,
      count: data.count,
      userCount: data.users.size,
    }))
    .filter((x) => x.count > 0);

  return sorted;
};

const getTopPeople = async (numDays = 7) => {
  const results = new Map();
  const items = await fetchData({ numDays });

  items.forEach((item) => {
    const emoji = item.sk;
    Object.keys(item.userCounts).forEach((userId) => {
      if (results.has(userId)) {
        const existing = results.get(userId);
        const existingEmojis = existing.emojis;

        if (existingEmojis.has(emoji)) {
          existingEmojis.set(
            emoji,
            existingEmojis.get(emoji) + item.userCounts[userId]
          );
        } else {
          existingEmojis.set(emoji, item.userCounts[userId]);
        }

        results.set(userId, {
          count: existing.count + item.userCounts[userId],
          emojis: existingEmojis,
        });
      } else {
        const emojis = new Map().set(emoji, item.userCounts[userId]);
        results.set(userId, {
          count: item.userCounts[userId],
          emojis,
        });
      }
    });
  });

  const sorted = [...results.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([userId, data]) => {
      const sortedEmojis = [...data.emojis.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }));

      return {
        userId,
        count: data.count,
        emojis: sortedEmojis,
      };
    })
    .filter((x) => x.count > 0);

  return sorted;
};

const getTopReactionsForUser = async (userId: string, numDays = 7) => {
  const results = new Map();
  const items = await fetchData({ numDays });
  items.forEach((item) => {
    if (results.has(item.sk)) {
      const existing = results.get(item.sk);
      results.set(item.sk, {
        count: existing.count + item.userCounts[userId] || 0,
      });
    } else {
      results.set(item.sk, {
        count: item.userCounts[userId] || 0,
      });
    }
  });

  const sorted = [...results.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, data]) => ({
      reaction: name,
      count: data.count,
    }))
    .filter((x) => x.count > 0);

  return sorted;
};

const getTopReactionsForEmoji = async (emoji: string, numDays = 7) => {
  const results = new Map();
  const items = await fetchData({ emoji, numDays });

  const total = items.reduce((acc, cur) => {
    acc = acc + cur.reactionCount;
    return acc;
  }, 0);

  items.forEach((item) => {
    Object.keys(item.userCounts).forEach((userId) => {
      if (results.has(userId)) {
        const existing = results.get(userId);
        results.set(userId, existing + item.userCounts[userId]);
      } else {
        results.set(userId, item.userCounts[userId]);
      }
    });
  });

  const sorted = [...results.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([userId, count]) => ({
      userId,
      count,
    }))
    .filter((x) => x.count > 0);

  return { total, sorted };
};

const fetchData = async ({
  emoji,
  numDays = 7,
}: {
  emoji?: string;
  numDays?: number;
}) => {
  const items = [];
  for (let i = 0; i < numDays; i++) {
    const pk = format(subDays(new Date(), i), "yyyy-MM-dd");

    let KeyConditionExpression = "pk = :pk";
    let ExpressionAttributeValues: any = { ":pk": pk };
    if (emoji) {
      KeyConditionExpression = "pk = :pk AND sk = :sk";
      ExpressionAttributeValues = { ":pk": pk, ":sk": emoji };
    }

    const response = await client
      .query({
        TableName: process.env.DATABASE_TABLE_NAME,
        KeyConditionExpression,
        ExpressionAttributeValues,
        Limit: 1000,
      })
      .promise();

    items.push(...response.Items);
  }
  return items;
};

export async function handleReactionAdded(payload: ReactionAdded) {
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

export async function handleReactionRemoved(payload: ReactionRemoved) {
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

const helpBlocks = [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        "• `/emojireport emoji` The top emoji reactions over the last 7 days",
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "• `/emojireport people` The top reactors over the last 7 days",
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        "• `/emojireport @user` The top emoji reactions by @user over the last 7 days",
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        "• `/emojireport :emoji:` The top emoji reactions by :emoji: over the last 7 days",
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "• `/emojireport help` Show the list of supported commands",
    },
  },
];

export function buildErrorPayload() {
  return {
    response_type: "ephemeral",
    blocks: [
      {
        type: "section",
        text: {
          type: "plain_text",
          text:
            "Sorry, I didn't understand that. I understand the following commands:",
          emoji: true,
        },
      },
      ...helpBlocks,
    ],
  };
}

export function buildHelpPayload() {
  return {
    response_type: "ephemeral",
    blocks: [
      {
        type: "section",
        text: {
          type: "plain_text",
          text: "I understand the following commands:",
          emoji: true,
        },
      },
      ...helpBlocks,
    ],
  };
}

export async function buildTopUsersPayload() {
  const data = await getTopPeople();
  const blocks = data.slice(0, 10).flatMap((datum, i) => {
    const rank = String(i + 1).padStart(2, "0");

    return [
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${rank}*)   <@${datum.userId}>   *${datum.count}* reactions`,
        },
      },
      {
        type: "context",
        elements: datum.emojis.slice(0, 10).map((emoji) => {
          return {
            type: "mrkdwn",
            text: `:${emoji.name}:   ${emoji.count}x`,
          };
        }),
      },
    ];
  });

  return {
    response_type: "in_channel",
    blocks: [
      {
        type: "section",
        text: {
          type: "plain_text",
          text: "The top reactors over the last 7 days are:",
          emoji: true,
        },
      },
      ...blocks,
      {
        type: "divider",
      },
    ],
  };
}

export async function buildTopReactionsPayload() {
  const data = await getTopReactions();
  const blocks = data.slice(0, 10).flatMap((datum, i) => {
    const rank = String(i + 1).padStart(2, "0");
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${rank}*) :${datum.reaction}: \`:${datum.reaction}:\``,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*${datum.count}* reactions, *${datum.userCount}* users`,
          },
        ],
      },
    ];
  });
  return {
    response_type: "in_channel",
    blocks: [
      {
        type: "section",
        text: {
          type: "plain_text",
          text: "The top emoji reactions over the last 7 days are:",
          emoji: true,
        },
      },
      ...blocks,
    ],
  };
}

export async function buildTopReactionsForUserPayload(userId: string) {
  const data = await getTopReactionsForUser(userId);
  const blocks = data.slice(0, 10).flatMap((datum, i) => {
    const rank = String(i + 1).padStart(2, "0");
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${rank}*) :${datum.reaction}: \`:${datum.reaction}:\` _${datum.count}x_`,
        },
      },
    ];
  });

  return {
    response_type: "in_channel",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: data.length
            ? `The top emoji reactions by <@${userId}> over the last 7 days are:`
            : `No emoji reactions by <@${userId}> over the last 7 days :white_frowning_face:`,
        },
      },
      ...blocks,
    ],
  };
}

export async function buildTopReactionsForEmojiPayload(emoji: string) {
  const { total, sorted } = await getTopReactionsForEmoji(emoji);

  const blocks = sorted.slice(0, 10).map((datum, i) => {
    const rank = String(i + 1).padStart(2, "0");
    return {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${rank}*) <@${datum.userId}> _${datum.count}x_`,
      },
    };
  });

  return {
    response_type: "in_channel",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: sorted.length
            ? `:${emoji}: \`:${emoji}:\` was used *${total}* times over the last 7 day days. The top users are:`
            : `:${emoji}: \`:${emoji}:\` was not used over the last 7 day days.`,
        },
      },
      ...blocks,
    ],
  };
}

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
