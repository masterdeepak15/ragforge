import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiFetch, apiStream } from '../lib/api';
import type { ChatSession, ChatMessage, ChatStreamEvent, Citation, KnowledgeBase } from '../types/api';
import ChatInterface from '../components/chat/ChatInterface';
import { Loader2 } from 'lucide-react';
import { toast } from '../components/ui/toaster';
import { KbNotice } from '../features/chat/KbNotice';
import { NoKbNotice } from '../features/chat/NoKbNotice';
import { useKbReadiness } from '../features/chat/useKbReadiness';

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.');

export default function ChatPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSession, setCurrentSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  /** What the assistant is doing before its first words arrive; null when idle or already writing. */
  const [kbError, setKbError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [pending, setPending] = useState<'thinking' | 'writing' | null>(null);
  const readiness = useKbReadiness(currentSession?.knowledge_base_id ?? undefined);

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
      toast.error(`Could not load your chats. ${messageOf(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const loadKnowledgeBases = async () => {
    try {
      const data = await apiFetch<KnowledgeBase[]>('/api/knowledge-bases');
      setKnowledgeBases(data);
    } catch (e) {
      toast.error(`Could not load knowledge bases. ${messageOf(e)}`);
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
      toast.error(`Could not open this chat. ${messageOf(e)}`);
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
      toast.error(`Could not start a chat. ${messageOf(e)}`);
    }
  };

  const deleteSession = async (session: ChatSession) => {
    setDeleteError('');
    try {
      await apiFetch(`/api/chat/sessions/${session.id}`, { method: 'DELETE' });
    } catch (e) {
      setDeleteError(`Could not delete the chat. ${messageOf(e)}`);
      return;
    }
    setSessions((prev) => prev.filter((x) => x.id !== session.id));
    if (currentSession?.id === session.id) {
      // Leave the deleted chat; the page then opens the next one, or shows the empty state.
      setCurrentSession(null);
      setMessages([]);
      navigate('/chat');
    }
  };

  const changeKnowledgeBase = async (knowledgeBaseId: string | null) => {
    if (!currentSession) return;
    setKbError('');
    try {
      const updated = await apiFetch<ChatSession>(`/api/chat/sessions/${currentSession.id}`, { method: 'PATCH', json: { knowledgeBaseId } });
      setCurrentSession(updated);
    } catch (e) {
      setKbError(`Could not change the knowledge base. ${messageOf(e)}`);
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

    // The reply is added on first use, then updated as tokens arrive.
    const showAssistant = (patch: Partial<ChatMessage>) =>
      setMessages((prev) =>
        prev.some((m) => m.id === assistantMsgId)
          ? prev.map((m) => (m.id === assistantMsgId ? { ...m, ...patch } : m))
          : [...prev, { id: assistantMsgId, session_id: currentSession.id, role: 'assistant' as const, content: '', created_at: new Date().toISOString(), ...patch }],
      );

    setPending('thinking');
    try {
      for await (const event of apiStream(`/api/chat/sessions/${currentSession.id}/stream`, {
        // How many passages to fetch, hybrid search and the similarity floor come from the knowledge base's settings.
        message: content,
      })) {
        const ev = event as ChatStreamEvent;
        if (ev.type === 'token') {
          setPending(null);
          assistantContent += ev.token;
          showAssistant({ content: assistantContent });
        } else if (ev.type === 'citation') {
          newCitations.push(ev.citation);
          setPending('writing');
        } else if (ev.type === 'done') {
          showAssistant({ citations: newCitations });
        } else if (ev.type === 'error') {
          setPending(null);
          showAssistant({ content: `I could not answer that. ${ev.error}` });
        }
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== assistantMsgId),
        {
          id: assistantMsgId,
          session_id: currentSession.id,
          role: 'assistant' as const,
          content: `I could not answer that. ${messageOf(e)}`,
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setPending(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />
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
      onChangeKnowledgeBase={changeKnowledgeBase}
      onDeleteSession={deleteSession}
      pending={pending}
      notice={
        (currentSession || deleteError) && (kbError || deleteError || !currentSession?.knowledge_base_id || readiness.data) ? (
          <div className="space-y-2">
            {(kbError || deleteError) && (
              <p role="alert" className="text-sm text-destructive">
                {kbError || deleteError}
              </p>
            )}
            {!currentSession ? null : currentSession.knowledge_base_id ? (
              <KbNotice kbId={currentSession.knowledge_base_id} ready={readiness.data?.ready} processing={readiness.data?.processing} />
            ) : (
              <NoKbNotice hasKnowledgeBases={knowledgeBases.length > 0} />
            )}
          </div>
        ) : null
      }
    />
  );
}