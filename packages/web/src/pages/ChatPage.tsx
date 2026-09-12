import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiFetch, apiStream } from '../lib/api';
import type { ChatSession, ChatMessage, ChatStreamEvent, Citation, KnowledgeBase } from '../types/api';
import ChatInterface from '../components/chat/ChatInterface';
import { Loader2 } from 'lucide-react';

export default function ChatPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSession, setCurrentSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSessions();
    loadKnowledgeBases();
  }, []);

  useEffect(() => {
    if (id) {
      loadSession(id);
    } else if (sessions.length > 0) {
      navigate(`/chat/${sessions[0].id}`, { replace: true });
    }
  }, [id, sessions]);

  const loadSessions = async () => {
    try {
      const data = await apiFetch<ChatSession[]>('/api/chat/sessions');
      setSessions(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const loadKnowledgeBases = async () => {
    try {
      const data = await apiFetch<KnowledgeBase[]>('/api/knowledge-bases');
      setKnowledgeBases(data);
    } catch (e) {
      console.error(e);
    }
  };

  const loadSession = async (sessionId: string) => {
    try {
      const [sessionData, messagesData] = await Promise.all([
        apiFetch<ChatSession>(`/api/chat/sessions/${sessionId}`),
        apiFetch<ChatMessage[]>(`/api/chat/sessions/${sessionId}/messages`),
      ]);
      setCurrentSession(sessionData);
      setMessages(messagesData.map((m: any) => ({
        ...m,
        citations: m.citations_json ? JSON.parse(m.citations_json) : undefined,
      })));
    } catch (e) {
      console.error(e);
    }
  };

  const createSession = async (knowledgeBaseId?: string) => {
    try {
      const session = await apiFetch<ChatSession>('/api/chat/sessions', {
        method: 'POST',
        json: { title: 'New Chat', knowledgeBaseId },
      });
      setSessions((prev) => [session, ...prev]);
      navigate(`/chat/${session.id}`);
    } catch (e) {
      console.error(e);
    }
  };

  const sendMessage = async (content: string) => {
    if (!currentSession) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      session_id: currentSession.id,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    const assistantMsgId = crypto.randomUUID();
    let assistantContent = '';
    const newCitations: Citation[] = [];

    try {
      for await (const event of apiStream(`/api/chat/sessions/${currentSession.id}/stream`, {
        message: content,
        topK: 6,
        useHybridSearch: true,
      })) {
        const ev = event as ChatStreamEvent;
        if (ev.type === 'token') {
          assistantContent += ev.token;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: assistantContent, role: 'assistant' as const }
                : m
            )
          );
        } else if (ev.type === 'citation') {
          newCitations.push(ev.citation);
        } else if (ev.type === 'done') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, citations: newCitations, role: 'assistant' as const }
                : m
            )
          );
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
      </div>
    );
  }

  return (
    <ChatInterface
      sessions={sessions}
      currentSession={currentSession}
      messages={messages}
      knowledgeBases={knowledgeBases}
      onSelectSession={(s) => navigate(`/chat/${s.id}`)}
      onNewSession={createSession}
      onSendMessage={sendMessage}
    />
  );
}