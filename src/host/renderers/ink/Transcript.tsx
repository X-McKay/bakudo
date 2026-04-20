import React from "react";
import { Box } from "ink";
import { useAppState } from "./hooks/useAppState.js";
import { UserMessage } from "./transcript/UserMessage.js";
import { AssistantMessage } from "./transcript/AssistantMessage.js";
import { EventLine } from "./transcript/EventLine.js";
import { OutputBlock } from "./transcript/OutputBlock.js";
import { ReviewCard } from "./transcript/ReviewCard.js";

export const Transcript = () => {
  const items = useAppState((s) => s.transcript);
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        if (item.kind === "user") return <UserMessage key={i} text={item.text} />;
        if (item.kind === "assistant")
          return item.tone !== undefined ? (
            <AssistantMessage key={i} text={item.text} tone={item.tone} />
          ) : (
            <AssistantMessage key={i} text={item.text} />
          );
        if (item.kind === "event")
          return item.detail !== undefined ? (
            <EventLine key={i} label={item.label} detail={item.detail} />
          ) : (
            <EventLine key={i} label={item.label} />
          );
        if (item.kind === "output") return <OutputBlock key={i} text={item.text} />;
        return item.nextAction !== undefined ? (
          <ReviewCard
            key={i}
            outcome={item.outcome}
            summary={item.summary}
            nextAction={item.nextAction}
          />
        ) : (
          <ReviewCard key={i} outcome={item.outcome} summary={item.summary} />
        );
      })}
    </Box>
  );
};
