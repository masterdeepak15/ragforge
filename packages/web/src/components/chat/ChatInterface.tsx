import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Send, Plus, MessageSquare } from 'lucide-react';
import type { ChatSession, ChatMessage, Citation, KnowledgeBase } from '../../types/api';
import CitationDrawer from './CitationDrawer';

interface Props {
  sessions: ChatSession[];
  currentSession: ChatSession | null;
  messages: ChatMessage[];
  knowledgeBases: KnowledgeBase[];
  onSelectSession: (session: ChatSession) => void;
  onNewSession: (kbId?: string) => void;
  onSendMessage: (content: string) => void;
}

export default function ChatInterface({
  sessions,
  currentSession,
  messages,
  knowledgeBases,
  onSelectSession,
  onNewSession,
  onSendMessage,
}: Props) {
  const [input, setInput] = useState('');
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [selectedKb, setSelectedKb] = useState<string>('');
  const [openCitation, setOpenCitation] = useState<Citation | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!input.trim() || !currentSession) return;
    onSendMessage(input.trim());
    setInput('');
  };

  const handleNewSession = () => {
    onNewSession(selectedKb || undefined);
    setShowNewSessionModal(false);
    setSelectedKb('');
  };

  const renderMessage = (msg: ChatMessage) => {
    const citationPattern = /\[(\d+)\]/g;
    const parts: (string | JSX.Element)[] = [];
    let lastIndex = 0;
    let match;

    while ((match = citationPattern.exec(msg.content)) !== null) {
      if (match.index > lastIndex) {
        parts.push(msg.content.slice(lastIndex, match.index));
      }
      const citationNum = parseInt(match[1]);
      const citation = msg.citations?.find((c) => c.citationIndex === citationNum);
      parts.push(
        <button
          key={`cite-${match.index}`}
          onClick={() => citation && setOpenCitation(citation)}
          className="inline-flex items-center justify-center w-5 h-5 text-xs font-medium bg-primary/20 text-primary rounded hover:bg-primary/30 transition-colors"
        >
          {citationNum}
        </button>
      );
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < msg.content.length) {
      parts.push(msg.content.slice(lastIndex));
    }

    return parts.length > 1 ? <span>{parts}</span> : msg.content;
  };

  return (
    <div className="flex h-screen">
      {/* Session list */}
      <div className="w-64 bg-card border-r border-border flex flex-col">
        <div className="p-3 border-b border-border">
          <button
            onClick={() => setShowNewSessionModal(true)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => onSelectSession(s)}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                currentSession?.id === s.id
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              }`}
            >
              <div className="flex items-start gap-2">
                <MessageSquare className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span className="line-clamp-2">{s.title}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col bg-background">
        {currentSession ? (
          <>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="max-w-3xl mx-auto space-y-6">
                {messages.map((msg, i) => (
                  <div key={i} className="animate-slide-in">
                    <div className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                      {msg.role === 'assistant' && (
                        <div className="w-8 h-8 rounded-full bg-primary flex-shrink-0" />
                      )}
                      <div
                        className={`max-w-2xl px-4 py-3 rounded-xl ${
                          msg.role === 'user'
                            ? 'bg-primary/10 text-foreground'
                            : 'bg-muted/50 text-foreground'
                        }`}
                      >
                        {msg.role === 'assistant' ? (
                          <div className="markdown-content prose prose-invert max-w-none">
                            {typeof renderMessage(msg) === 'string' ? (
                              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                                {renderMessage(msg) as string}
                              </ReactMarkdown>
                            ) : (
                              renderMessage(msg)
                            )}
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap">{msg.content}</p>
                        )}
                      </div>
                      {msg.role === 'user' && (
                        <div className="w-8 h-8 rounded-full bg-muted flex-shrink-0" />
                      )}
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Input bar */}
            <div className="border-t border-border p-4">
              <div className="max-w-3xl mx-auto flex gap-3">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder="Ask a question..."
                  className="flex-1 px-4 py-3 bg-muted border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-ring focus:border-transparent"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className="px-6 py-3 bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-primary-foreground font-medium rounded-xl transition-colors"
                >
                  <Send className="w-5 h-5" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageSquare className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
              <p>Select a chat or create a new one</p>
            </div>
          </div>
        )}
      </div>

      {/* New session modal */}
      {showNewSessionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-card rounded-xl border border-border p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-foreground mb-4">New Chat</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground/80 mb-2">
                  Knowledge Base (optional)
                </label>
                <select
                  value={selectedKb}
                  onChange={(e) => setSelectedKb(e.target.value)}
                  className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-foreground focus:ring-2 focus:ring-ring focus:border-transparent"
                >
                  <option value="">None</option>
                  {knowledgeBases.map((kb) => (
                    <option key={kb.id} value={kb.id}>
                      {kb.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowNewSessionModal(false)}
                  className="flex-1 px-4 py-2 bg-muted hover:bg-muted text-foreground rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleNewSession}
                  className="flex-1 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors"
                >
                  Create
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Citation drawer */}
      <CitationDrawer citation={openCitation} onClose={() => setOpenCitation(null)} />
    </div>
  );
}