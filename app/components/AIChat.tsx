import { useState, useRef, useEffect } from "react";
import {
  Card,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Box,
  Spinner,
} from "@shopify/polaris";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export function AIChat() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: "Hi! I'm your AI assistant. Ask me questions about your store's inventory, sales, and products. For example:\n\n• How many blue shirts did we sell in the last 3 months?\n• How much Helly Hansen inventory do we have?\n• What are our best selling products this year?",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");

    // Add user message
    const newMessages = [...messages, { role: "user" as const, content: userMessage }];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });

      const data = await response.json();

      if (data.error) {
        setMessages([
          ...newMessages,
          {
            role: "assistant",
            content: `Sorry, I encountered an error: ${data.error}`,
          },
        ]);
      } else {
        setMessages([
          ...newMessages,
          { role: "assistant", content: data.message },
        ]);
      }
    } catch (error) {
      setMessages([
        ...newMessages,
        {
          role: "assistant",
          content: "Sorry, I couldn't process your request. Please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            🤖 AI Assistant
          </Text>
          {isLoading && <Spinner size="small" />}
        </InlineStack>

        <Box
          padding="400"
          background="bg-surface-secondary"
          borderRadius="200"
          minHeight="400px"
          maxHeight="500px"
          style={{
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          {messages.map((message, index) => (
            <Box
              key={index}
              padding="300"
              background={message.role === "user" ? "bg-surface-brand" : "bg-surface"}
              borderRadius="200"
              style={{
                alignSelf: message.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "80%",
              }}
            >
              <Text
                as="p"
                variant="bodyMd"
                tone={message.role === "user" ? "text-inverse" : undefined}
              >
                <div style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
              </Text>
            </Box>
          ))}
          <div ref={messagesEndRef} />
        </Box>

        <InlineStack gap="200">
          <div style={{ flex: 1 }}>
            <TextField
              label=""
              value={input}
              onChange={setInput}
              onKeyPress={handleKeyPress}
              placeholder="Ask me about your inventory, sales, or products..."
              autoComplete="off"
              disabled={isLoading}
            />
          </div>
          <Button
            onClick={handleSubmit}
            variant="primary"
            disabled={!input.trim() || isLoading}
            loading={isLoading}
          >
            Send
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
