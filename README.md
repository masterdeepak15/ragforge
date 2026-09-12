# RAGForge

**A self-hosted, open-source Knowledge Base and AI Agent platform with dual-distribution philosophy**

RAGForge enables organizations to build powerful knowledge management systems with integrated AI chat capabilities. Deploy locally for development with zero dependencies, or scale to production with PostgreSQL + pgvector.

## 🚀 Quick Start

### Local Development (SQLite)
```bash
# Clone the repository
git clone https://github.com/masterdeepak15/ragforge.git
cd ragforge

# Install dependencies
npm install

# Build the project
npm run build

# Start RAGForge
npx ragforge start
```

Navigate to `http://localhost:3000` to access the RAGForge interface.

### Production (PostgreSQL + pgvector)
```bash
# Start PostgreSQL with pgvector
docker-compose up -d

# Set environment variables
export DATABASE_URL="postgresql://user:password@localhost:5432/ragforge"
export NODE_ENV="production"

# Build and start
npm run build
npx ragforge start
```

## ✨ Features

### 🧠 **Dual Storage Architecture**
- **Local Mode**: SQLite with pure JavaScript/WASM (@libsql/client) - zero native dependencies
- **Production Mode**: PostgreSQL + pgvector for enterprise-scale vector operations

### 🔍 **Advanced RAG Pipeline**
- **Hybrid Search**: Combines semantic vector similarity with BM25 keyword search
- **Reciprocal Rank Fusion**: Merges vector and keyword results (70% vector, 30% BM25)
- **Smart Chunking**: Recursive text splitting with overlap for optimal context preservation
- **Citation System**: Full source attribution with clickable references

### 🤖 **Multi-Provider AI Support**
- **OpenAI**: GPT models with API key authentication
- **Anthropic**: Claude models with API key authentication  
- **Google Gemini**: OAuth2 PKCE flow + API key support
- **Groq**: Fast inference with API key authentication
- **Ollama**: Local LLM support with automatic model detection

### 🔐 **Enterprise Security**
- **AES-256-GCM Encryption**: All credentials encrypted at rest
- **JWT Authentication**: Secure session management
- **OAuth2 PKCE**: Industry-standard authentication flows
- **CORS Protection**: Configurable cross-origin policies

### 💬 **Real-time Chat Interface**
- **Server-Sent Events (SSE)**: Streaming responses with live updates
- **Citation Preview**: Expandable source document references
- **Context-Aware**: Maintains conversation history with knowledge base context
- **Multi-Session Support**: Concurrent chat sessions per knowledge base

### 📚 **Knowledge Base Management**
- **Multi-Format Support**: PDF, TXT, MD, DOCX document ingestion
- **Batch Upload**: Drag-and-drop multiple files
- **Metadata Extraction**: Automatic document metadata and statistics
- **Vector Indexing**: Automatic embedding generation and storage

## 🏗️ Architecture

RAGForge is built as a modern monorepo with three main packages:

```
packages/
├── shared/          # Common types, schemas, and utilities
├── server/          # Fastify backend with AI providers and RAG engine
└── web/             # React 19 frontend with Tailwind CSS
```

### Tech Stack

#### Backend
- **Framework**: Fastify 5 with TypeScript
- **Database**: Drizzle ORM with dual SQLite/PostgreSQL schemas
- **Vector Storage**: Custom implementations for both SQLite and pgvector
- **AI Integration**: Provider abstraction layer with streaming support
- **Authentication**: JWT + OAuth2 with PKCE

#### Frontend  
- **Framework**: React 19 with React Router 6
- **Styling**: Tailwind CSS with dark theme support
- **Icons**: Lucide React icon library
- **Build Tool**: Vite with TypeScript
- **State Management**: React Context + local state

#### Infrastructure
- **Containerization**: Docker + docker-compose
- **Process Management**: PM2 support for production
- **Monitoring**: Health check endpoints
- **Static Serving**: Built-in SPA static file serving

## 🛠️ Development

### Prerequisites
- Node.js 18+ 
- npm 8+
- Docker (for PostgreSQL setup)

### Development Setup
```bash
# Clone and install
git clone https://github.com/masterdeepak15/ragforge.git
cd ragforge
npm install

# Start development servers
npm run dev:server    # Backend on :3000
npm run dev:web       # Frontend on :5173

# Run type checking
npm run typecheck

# Build for production
npm run build
```

### Environment Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Database (choose one)
DATABASE_URL="file:./ragforge.db"  # SQLite (default)
# DATABASE_URL="postgresql://user:pass@localhost:5432/ragforge"  # PostgreSQL

# Security
JWT_SECRET="your-secure-jwt-secret"
ENCRYPTION_KEY="your-32-char-encryption-key"

# Server
PORT=3000
NODE_ENV="development"

# CORS (optional)
CORS_ORIGINS="http://localhost:5173,http://localhost:3000"
```

### Project Structure

```
ragforge/
├── packages/
│   ├── shared/                 # Shared utilities and types
│   │   └── src/
│   │       ├── types/          # TypeScript type definitions
│   │       └── schemas/        # Zod validation schemas
│   ├── server/                 # Backend application
│   │   ├── bin/ragforge.js     # CLI entry point
│   │   ├── src/
│   │   │   ├── core/           # Core business logic
│   │   │   │   ├── ingestion/  # Document processing
│   │   │   │   ├── providers/  # AI provider integrations
│   │   │   │   ├── retrieval/  # RAG and search logic
│   │   │   │   └── vector/     # Vector storage implementations
│   │   │   ├── db/             # Database schemas and connections
│   │   │   ├── routes/         # API route handlers
│   │   │   └── services/       # Business logic services
│   │   └── public/             # Built frontend assets
│   └── web/                    # Frontend React application
│       └── src/
│           ├── components/     # Reusable UI components
│           ├── pages/          # Route page components
│           ├── lib/            # Utilities and API client
│           └── types/          # Frontend-specific types
├── docker-compose.yml          # PostgreSQL setup
├── Dockerfile                  # Production container
└── OVERVIEW.html              # Technical architecture guide
```

## 📖 API Reference

### Authentication
```bash
# Create account
POST /api/auth/register
# Login
POST /api/auth/login  
# Get user profile
GET /api/auth/me
```

### Knowledge Bases
```bash
# List knowledge bases
GET /api/knowledge-bases
# Create knowledge base  
POST /api/knowledge-bases
# Get details
GET /api/knowledge-bases/:id
# Delete knowledge base
DELETE /api/knowledge-bases/:id
```

### Document Management
```bash
# Upload documents
POST /api/knowledge-bases/:id/documents
# List documents
GET /api/knowledge-bases/:id/documents
# Delete document
DELETE /api/documents/:id
```

### Chat & Retrieval
```bash
# Stream chat (SSE)
GET /api/knowledge-bases/:id/chat/stream
# Retrieve chunks
POST /api/playground/retrieve
# Test retrieval
GET /api/knowledge-bases/:id/search?q=query
```

### AI Providers
```bash
# List providers
GET /api/providers
# Configure provider
POST /api/providers  
# OAuth callback
GET /auth/google/callback
GET /auth/groq/callback
```

## 🔧 Configuration

### AI Provider Setup

#### OpenAI
1. Get API key from [OpenAI Platform](https://platform.openai.com/)
2. Add in Settings → AI Providers → Add OpenAI
3. Enter your API key

#### Anthropic Claude  
1. Get API key from [Anthropic Console](https://console.anthropic.com/)
2. Add in Settings → AI Providers → Add Anthropic
3. Enter your API key

#### Google Gemini (OAuth)
1. Create project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable Generative AI API
3. Create OAuth2 credentials with redirect: `http://localhost:3000/auth/google/callback`
4. Add in Settings → Use OAuth flow

#### Groq (OAuth)
1. Create account at [Groq Console](https://console.groq.com/)
2. Create OAuth application
3. Add in Settings → Use OAuth flow

#### Ollama (Local)
1. Install [Ollama](https://ollama.ai/)
2. Run: `ollama serve`
3. RAGForge will auto-detect at `http://localhost:11434`

### Database Migration

#### SQLite → PostgreSQL
```bash
# 1. Export data (implement custom migration)
# 2. Set new DATABASE_URL 
export DATABASE_URL="postgresql://user:pass@localhost/ragforge"
# 3. Restart server (auto-migrates schema)
npm restart
```

## 🚀 Deployment

### Docker Deployment
```bash
# Build image
docker build -t ragforge .

# Run with PostgreSQL
docker-compose up -d
```

### Production Environment
```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start packages/server/bin/ragforge.js --name ragforge

# Monitor
pm2 status ragforge
pm2 logs ragforge
```

### Environment Variables (Production)
```bash
NODE_ENV=production
DATABASE_URL="postgresql://user:pass@host:5432/ragforge"
JWT_SECRET="secure-random-string"
ENCRYPTION_KEY="32-character-encryption-key"
PORT=3000
```

## 🧪 Testing

```bash
# Run type checking
npm run typecheck

# Test database connection
npx ragforge start --check-db

# Test AI provider
curl http://localhost:3000/api/providers
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Development Guidelines
- Follow TypeScript strict mode
- Use Prettier for code formatting
- Add JSDoc comments for public APIs
- Include error handling for all external calls
- Test both SQLite and PostgreSQL code paths

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Documentation**: See `OVERVIEW.html` for technical architecture
- **Issues**: [GitHub Issues](https://github.com/masterdeepak15/ragforge/issues)
- **Discussions**: [GitHub Discussions](https://github.com/masterdeepak15/ragforge/discussions)

## 🔮 Roadmap

- [ ] **Multi-tenancy**: Organization and team management
- [ ] **Advanced RAG**: Graph-based knowledge representation  
- [ ] **Custom Embeddings**: Fine-tuned embedding models
- [ ] **API Analytics**: Usage tracking and performance metrics
- [ ] **Plugin System**: Custom document processors and AI providers
- [ ] **Collaborative Features**: Shared knowledge bases and annotations
- [ ] **Advanced Search**: Faceted search and filtering
- [ ] **Export/Import**: Knowledge base backup and migration tools

---

**RAGForge** - Empowering organizations with intelligent knowledge management 🚀

Built with ❤️ using React 19, Fastify 5, and modern TypeScript