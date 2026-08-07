import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './new.css';

// Safe Tauri Invoke Helper
const safeInvoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (e) {
    console.warn(`[Tauri] Called '${cmd}' outside native desktop context`, args);
    return null as unknown as T;
  }
};

// Icons
const Icons = {
  Send: memo(({ className = "w-5 h-5 fill-current" }: { className?: string }) => (
    <svg className={className} viewBox="0 0 24 24">
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  )),
  Image: memo(({ className = "w-5 h-5 fill-current" }: { className?: string }) => (
    <svg className={className} viewBox="0 0 24 24">
      <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
    </svg>
  )),
  Copy: memo(() => (
    <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
    </svg>
  )),
  ChevronDown: memo(() => (
    <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
      <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
    </svg>
  )),
  ChevronUp: memo(() => (
    <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
      <path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6 1.41 1.41z" />
    </svg>
  )),
  DoorExit: memo(() => (
    <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
      <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
    </svg>
  )),
  ArrowDown: memo(() => (
    <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
      <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
    </svg>
  )),
};

const PASTEL_COLORS = [
  '#2a3942', '#1f2c34', '#374151', '#1e293b',
  '#27272a', '#1e1b4b', '#111827', '#0f172a'
];

interface UserProfile {
  id: string;
  name: string;
  photo_b64?: string;
  color: string;
}

interface ChatMessage {
  id: string;
  room_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  msg_type: 'text' | 'image' | 'code';
  timestamp: number;
}

interface PollState {
  poll_id: string;
  candidate_id: string;
  candidate_name: string;
  yes_votes: number;
  total_votes: number;
  active: boolean;
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [photoInput, setPhotoInput] = useState<string | null>(null);

  const [serverUrl, setServerUrl] = useState('http://localhost:8080');
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [roomCodeInput, setRoomCodeInput] = useState('');
  
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('disconnected');
  const [connectError, setConnectError] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [textInput, setTextInput] = useState('');
  const [roomPeers, setRoomPeers] = useState<UserProfile[]>([]);
  
  const [peerStatus, setPeerStatus] = useState<string | null>(null);
  const [poll, setPoll] = useState<PollState | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false);

  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const eventSourceRef = useRef<EventSource | null>(null);
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastTypingEmitRef = useRef<number>(0);
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const prevScrollHeightRef = useRef<number>(0);
  const prevScrollTopRef = useRef<number>(0);
  const isLoadingOlderRef = useRef<boolean>(false);

  // De-duplicated online users list
  const onlineUsersList = useMemo(() => {
    const peerMap = new Map<string, UserProfile>();
    if (user) {
      peerMap.set(user.id, user);
    }
    roomPeers.forEach((p) => {
      if (p.id) peerMap.set(p.id, p);
    });
    return Array.from(peerMap.values());
  }, [user, roomPeers]);

  const otherPeersList = useMemo(() => {
    if (!user) return roomPeers;
    return onlineUsersList.filter((p) => p.id !== user.id);
  }, [user, onlineUsersList, roomPeers]);

  useEffect(() => {
    safeInvoke<UserProfile | null>('get_user_profile')
      .then((res) => { if (res) setUser(res); })
      .catch(console.error);
  }, []);

  const loadLocalMessages = useCallback(async (currentOffset: number, reset = false) => {
    if (!activeRoomId) return;

    if (!reset && mainScrollRef.current) {
      isLoadingOlderRef.current = true;
      prevScrollHeightRef.current = mainScrollRef.current.scrollHeight;
      prevScrollTopRef.current = mainScrollRef.current.scrollTop;
    }

    try {
      const fetched = await safeInvoke<ChatMessage[]>('get_messages', {
        roomId: activeRoomId,
        offset: currentOffset,
        limit: 100,
      });

      const validFetched = fetched || [];
      setHasMore(validFetched.length === 100);

      if (reset) {
        setMessages(validFetched);
        setOffset(validFetched.length);
        setTimeout(() => {
          if (mainScrollRef.current) {
            mainScrollRef.current.scrollTop = mainScrollRef.current.scrollHeight;
          }
        }, 50);
      } else {
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          const uniqueNew = validFetched.filter((m) => !existingIds.has(m.id));
          return [...uniqueNew, ...prev];
        });
        setOffset((prev) => prev + validFetched.length);
      }
    } catch (e) {
      console.error(e);
    }
  }, [activeRoomId]);

  useEffect(() => {
    if (user && activeRoomId) {
      loadLocalMessages(0, true);
    }
  }, [user, activeRoomId, loadLocalMessages]);

  useEffect(() => {
    if (isLoadingOlderRef.current && mainScrollRef.current) {
      const newScrollHeight = mainScrollRef.current.scrollHeight;
      mainScrollRef.current.scrollTop =
        prevScrollTopRef.current + (newScrollHeight - prevScrollHeightRef.current);
      isLoadingOlderRef.current = false;
    }
  }, [messages]);

  const sendHttpPayload = useCallback(async (payload: object) => {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    try {
      await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error('HTTP send error:', err);
    }
  }, [serverUrl]);

  const connectAndJoinRoom = useCallback((targetRoomId: string) => {
    setConnStatus('connecting');
    setConnectError(null);

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    try {
      const baseUrl = serverUrl.replace(/\/+$/, '');
      const sseUrl = `${baseUrl}/events?room_id=${encodeURIComponent(targetRoomId)}&user_id=${encodeURIComponent(user?.id || '')}`;
      const es = new EventSource(sseUrl);

      es.onopen = () => {
        eventSourceRef.current = es;
        setConnStatus('connected');
        setActiveRoomId(targetRoomId);

        sendHttpPayload({ type: 'join_room', room_id: targetRoomId, sender_id: user?.id, user });
        sendHttpPayload({ type: 'sync_request', room_id: targetRoomId, sender_id: user?.id });
      };

      es.onerror = () => {
        setConnStatus('disconnected');
        setConnectError('خطا در اتصال به سرور! آدرس HTTP را بررسی کنید.');
      };

      es.onmessage = async (evt) => {
        if (!evt.data) return;
        const data = JSON.parse(evt.data);

        if (data.type === 'chat_message') {
          const msg: ChatMessage = data.message;
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
          });

          await safeInvoke('save_message', { msg });

          if (mainScrollRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = mainScrollRef.current;
            const isNearBottom = scrollHeight - scrollTop - clientHeight < 150;
            if (isNearBottom || msg.sender_id === user?.id) {
              setTimeout(() => {
                if (mainScrollRef.current) {
                  mainScrollRef.current.scrollTop = mainScrollRef.current.scrollHeight;
                }
              }, 50);
            } else {
              setShowScrollBottomBtn(true);
            }
          }
        } 
        else if (data.type === 'sync_request' && data.sender_id !== user?.id) {
          const localMsgs = await safeInvoke<ChatMessage[]>('get_messages', {
            roomId: targetRoomId,
            offset: 0,
            limit: 500,
          });

          if (localMsgs && localMsgs.length > 0) {
            sendHttpPayload({
              type: 'sync_response',
              room_id: targetRoomId,
              target_id: data.sender_id,
              sender_id: user?.id,
              messages: localMsgs,
            });
          }
        } 
        else if (data.type === 'sync_response' && data.target_id === user?.id) {
          const incomingMsgs: ChatMessage[] = data.messages || [];
          if (incomingMsgs.length > 0) {
            await safeInvoke('save_messages_batch', { msgs: incomingMsgs });

            setMessages((prev) => {
              const existingIds = new Set(prev.map((m) => m.id));
              const uniqueNew = incomingMsgs.filter((m) => !existingIds.has(m.id));
              if (uniqueNew.length === 0) return prev;
              const merged = [...prev, ...uniqueNew].sort((a, b) => a.timestamp - b.timestamp);
              return merged;
            });

            setTimeout(() => {
              if (mainScrollRef.current) {
                mainScrollRef.current.scrollTop = mainScrollRef.current.scrollHeight;
              }
            }, 100);
          }
        } else if (data.type === 'room_peers') {
          setRoomPeers(data.peers || []);
        } else if (data.type === 'typing' && data.sender_id !== user?.id) {
          setPeerStatus(`${data.sender_name} در حال نوشتن...`);
          if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current);
          statusTimeoutRef.current = setTimeout(() => setPeerStatus(null), 2000);
        } else if (data.type === 'sending_image' && data.sender_id !== user?.id) {
          setPeerStatus(`${data.sender_name} در حال ارسال عکس...`);
          if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current);
          statusTimeoutRef.current = setTimeout(() => setPeerStatus(null), 3000);
        } else if (data.type === 'join_request_poll') {
          setPoll(data.poll);
        } else if (data.type === 'poll_result') {
          setPoll(null);
          if (data.accepted && data.candidate_id === user?.id) {
            setActiveRoomId(data.room_id);
          }
        }
      };
    } catch {
      setConnStatus('disconnected');
      setConnectError('فرمت آدرس URL نامعتبر است.');
    }
  }, [serverUrl, user, sendHttpPayload]);

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameInput.trim()) return;

    const newProfile: UserProfile = {
      id: 'usr_' + Math.random().toString(36).substring(2, 11),
      name: nameInput.trim(),
      photo_b64: photoInput || undefined,
      color: PASTEL_COLORS[Math.floor(Math.random() * PASTEL_COLORS.length)],
    };

    await safeInvoke('save_user_profile', { profile: newProfile });
    setUser(newProfile);
  };

  const handleEnterRoomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const code = roomCodeInput.trim();
    if (!code || !serverUrl.trim()) return;
    connectAndJoinRoom(code);
  };

  const handleSendMessage = async () => {
    if (!textInput.trim() || !user || !activeRoomId) return;

    const trimmed = textInput.trim();
    const msg: ChatMessage = {
      id: 'msg_' + Math.random().toString(36).substring(2, 11),
      room_id: activeRoomId,
      sender_id: user.id,
      sender_name: user.name,
      content: trimmed,
      msg_type: 'text',
      timestamp: Date.now(),
    };

    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });

    await safeInvoke('save_message', { msg });

    setTextInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    sendHttpPayload({ type: 'chat_message', room_id: activeRoomId, message: msg });

    setTimeout(() => {
      if (mainScrollRef.current) {
        mainScrollRef.current.scrollTop = mainScrollRef.current.scrollHeight;
      }
    }, 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleInputChange = (val: string) => {
    setTextInput(val);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const newHeight = Math.min(textareaRef.current.scrollHeight, 115);
      textareaRef.current.style.height = `${newHeight}px`;
    }

    const now = Date.now();
    if (user && activeRoomId && now - lastTypingEmitRef.current > 1500) {
      lastTypingEmitRef.current = now;
      sendHttpPayload({
        type: 'typing',
        room_id: activeRoomId,
        sender_id: user.id,
        sender_name: user.name,
      });
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user || !activeRoomId) return;

    sendHttpPayload({
      type: 'sending_image',
      room_id: activeRoomId,
      sender_id: user.id,
      sender_name: user.name,
    });

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const rawB64 = reader.result as string;
        const webpB64 = await safeInvoke<string>('convert_to_webp', { base64Raw: rawB64 });

        const msg: ChatMessage = {
          id: 'msg_' + Math.random().toString(36).substring(2, 11),
          room_id: activeRoomId,
          sender_id: user.id,
          sender_name: user.name,
          content: webpB64 || rawB64,
          msg_type: 'image',
          timestamp: Date.now(),
        };

        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });

        await safeInvoke('save_message', { msg });

        sendHttpPayload({ type: 'chat_message', room_id: activeRoomId, message: msg });

        setTimeout(() => {
          if (mainScrollRef.current) {
            mainScrollRef.current.scrollTop = mainScrollRef.current.scrollHeight;
          }
        }, 50);
      } catch (err) {
        console.error('Image upload failed', err);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleScroll = () => {
    if (!mainScrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = mainScrollRef.current;
    if (scrollHeight - scrollTop - clientHeight < 100) {
      setShowScrollBottomBtn(false);
    }
  };

  const scrollToBottom = () => {
    if (mainScrollRef.current) {
      mainScrollRef.current.scrollTo({ top: mainScrollRef.current.scrollHeight, behavior: 'smooth' });
      setShowScrollBottomBtn(false);
    }
  };

  const handleVote = (vote: boolean) => {
    if (!poll || !user) return;
    sendHttpPayload({
      type: 'vote_cast',
      poll_id: poll.poll_id,
      user_id: user.id,
      vote,
    });
  };

  // Profile Step
  if (!user) {
    return (
      <div dir="rtl" className="w-full h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-3xl p-7 shadow-2xl flex flex-col items-center">
          <h1 className="text-2xl font-bold mb-1 tracking-wide text-zinc-100">
            Jelopathy <span className="text-xs text-zinc-500 font-mono ml-1">v1</span>
          </h1>
          <p className="text-xs text-zinc-400 mb-6 text-center">ایجاد حساب کاربری جدید</p>

          <form onSubmit={handleProfileSubmit} className="w-full space-y-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">نام یا نام مستعار:</label>
              <input
                type="text"
                required
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="مثلا: علی..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
              />
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">تصویر پروفایل (اختیاری):</label>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const r = new FileReader();
                    r.onload = () => setPhotoInput(r.result as string);
                    r.readAsDataURL(file);
                  }
                }}
                className="w-full text-xs text-zinc-400 file:ml-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:bg-zinc-800 file:text-zinc-200 hover:file:bg-zinc-700 cursor-pointer"
              />
            </div>

            <button
              type="submit"
              className="w-full bg-zinc-100 text-zinc-950 font-bold py-3 rounded-xl text-sm hover:bg-zinc-300 transition-colors mt-2"
            >
              ذخیره و ادامه
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Server Setup Step
  if (!activeRoomId) {
    return (
      <div dir="rtl" className="w-full h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-3xl p-7 shadow-2xl flex flex-col items-center">
          <div className="flex items-center space-x-3 space-x-reverse mb-6">
            {user.photo_b64 ? (
              <img src={user.photo_b64} className="mx-2 w-12 h-12 rounded-full object-cover" alt="Avatar" />
            ) : (
              <div
                className="mx-2 w-12 h-12 rounded-full flex items-center justify-center font-bold text-sm"
                style={{ backgroundColor: user.color }}
              >
                {user.name.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="px-1.5">
              <h2 className="text-sm font-bold">{user.name}</h2>
              <span className="text-[11px] text-zinc-400">خوش آمدید</span>
            </div>
          </div>

          <h3 className="text-base font-bold text-zinc-200 mb-1">ورود به گفتگو</h3>
          <p className="text-xs text-zinc-400 text-center mb-5">
            آدرس سرور HTTP و کد اتاق را وارد کنید:
          </p>

          <form onSubmit={handleEnterRoomSubmit} className="w-full space-y-3.5">
            <div>
              <label className="block text-xs text-zinc-400 mb-1 font-mono">Server HTTP URL:</label>
              <input
                type="text"
                required
                dir="ltr"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="http://localhost:8080"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-500 font-mono ltr-code"
              />
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">کد اتاق / گروه:</label>
              <input
                type="text"
                required
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value)}
                placeholder="مثلا: global یا room123..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500 text-center"
              />
            </div>

            {connectError && (
              <div className="text-xs text-red-400 text-center bg-red-950/40 border border-red-900/50 p-2 rounded-xl">
                {connectError}
              </div>
            )}

            <button
              type="submit"
              disabled={connStatus === 'connecting'}
              className="w-full bg-zinc-100 text-zinc-950 font-bold py-3 rounded-xl text-sm hover:bg-zinc-300 transition-colors disabled:opacity-50"
            >
              {connStatus === 'connecting' ? 'در حال برقراری اتصال...' : 'اتصال و ورود به چت'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Active Chat Screen
  return (
    <div dir="rtl" className="w-full h-screen bg-zinc-950 text-zinc-100 flex flex-col overflow-hidden relative">
      <header className="h-14 bg-zinc-900/90 backdrop-blur-md border-b border-zinc-800/80 px-4 flex items-center justify-between shrink-0 z-10">
        <div
          className="flex items-center space-x-3 space-x-reverse cursor-pointer hover:opacity-80 transition-opacity"
          onClick={() => setShowAccountModal(true)}
        >
          {user.photo_b64 ? (
            <img src={user.photo_b64} className="mx-2 w-9 h-9 mr-2 rounded-full object-cover" alt="Avatar" />
          ) : (
            <div
              className="mx-2 w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs"
              style={{ backgroundColor: user.color }}
            >
              {user.name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="flex flex-col">
            <span className="text-xs font-bold leading-tight">{user.name}</span>
            <span className="text-[10px] text-zinc-400">
              اتاق: {activeRoomId} ({onlineUsersList.length} آنلاین)
            </span>
          </div>
        </div>

        <div className="font-extrabold text-base tracking-wide text-zinc-100 flex items-center">
          Jelopathy
          <span className="text-[10px] bg-zinc-800 text-zinc-400 font-mono px-1 py-1 mx-1 rounded ml-1.5 border border-zinc-700">
            v1
          </span>
        </div>

        <button
          onClick={() => {
            if (eventSourceRef.current) eventSourceRef.current.close();
            setActiveRoomId(null);
          }}
          title="خروج از این اتاق"
          className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-xl transition-colors"
        >
          <Icons.DoorExit />
        </button>
      </header>

      {/* Main Message Stream */}
      <main
        ref={mainScrollRef}
        onScroll={handleScroll}
        className="ltr-auto flex-1 overflow-y-auto p-4 space-y-2 bg-zinc-950"
      >
        {hasMore && (
          <div className="flex justify-center my-2">
            <button
              onClick={() => loadLocalMessages(offset)}
              className="bg-zinc-900 border border-zinc-800 text-zinc-400 text-xs px-4 py-1.5 rounded-full hover:bg-zinc-800 transition-colors"
            >
              بارگذاری پیام‌های قدیمی‌تر
            </button>
          </div>
        )}

        {messages.map((m) => (
          <ChatMessageItem key={m.id} message={m} isMe={m.sender_id === user.id} />
        ))}
      </main>

      {/* Jump to Bottom Button */}
      {showScrollBottomBtn && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-20 left-6 z-20 bg-zinc-800 text-zinc-200 border border-zinc-700 p-2.5 rounded-full shadow-xl hover:bg-zinc-700 transition-all flex items-center space-x-1"
        >
          <Icons.ArrowDown />
        </button>
      )}

      {/* Peer Status Bar */}
      {peerStatus && (
        <div className="bg-zinc-900 px-4 py-1 text-xs text-zinc-400 italic border-t border-zinc-800 animate-pulse">
          {peerStatus}
        </div>
      )}

      {/* Input Controls */}
      <footer className="ltr-auto p-3 bg-zinc-900 border-t border-zinc-800 shrink-0">
        <div className="flex items-end max-w-4xl mx-auto">
          <label className="p-2.5 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-zinc-300 transition-colors cursor-pointer shrink-0 mb-0.5 flex items-center justify-center w-10 h-10">
            <Icons.Image />
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
            />
          </label>

          <textarea
            ref={textareaRef}
            rows={1}
            dir="auto"
            value={textInput}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="پیام خود را بنویسید... (Shift+Enter برای خط بعدی)"
            className="flex-1 mx-2 bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 resize-none min-h-[38px] max-h-[115px] leading-relaxed placeholder:text-right"
            style={{ unicodeBidi: 'plaintext' }}
          />

          <button
            onClick={handleSendMessage}
            className="p-2.5 bg-zinc-100 text-zinc-950 rounded-xl hover:bg-zinc-300 transition-colors shrink-0 mb-0.5 flex items-center justify-center w-10 h-10"
            title="ارسال"
          >
            <Icons.Send className="w-5 h-5 fill-current" />
          </button>
        </div>
      </footer>

      {/* Account Modal */}
      {showAccountModal && (
        <div className="absolute inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 w-full max-w-sm space-y-5 max-h-[85vh] flex flex-col">
            <h3 className="text-sm font-bold text-zinc-100 text-center">جزئیات حساب و کاربران گفتگو</h3>

            <div className="flex items-center space-x-3 space-x-reverse bg-zinc-950 p-3 rounded-2xl border border-zinc-800">
              {user.photo_b64 ? (
                <img src={user.photo_b64} className="mx-2 w-12 h-12 rounded-full object-cover" alt="User Avatar" />
              ) : (
                <div
                  className="mx-2 w-12 h-12 rounded-full flex items-center justify-center font-bold text-sm"
                  style={{ backgroundColor: user.color }}
                >
                  {user.name.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="flex flex-col">
                <span className="font-bold text-sm">{user.name} (شما)</span>
                <span dir="ltr" className="text-[10px] text-zinc-500 font-mono select-all text-left">ID: {user.id}</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              <span className="block text-xs font-bold text-zinc-400 mb-2">
                کاربران حاضر در اتاق ({onlineUsersList.length}):
              </span>

              <div className="grid grid-cols-2 gap-2">
                <div className="bg-zinc-950/80 border border-zinc-800 p-2.5 rounded-xl flex items-center space-x-2 space-x-reverse">
                  <div
                    className="mx-2 w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold"
                    style={{ backgroundColor: user.color }}
                  >
                    {user.name.slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-xs text-zinc-200 truncate">{user.name}</span>
                </div>

                {otherPeersList.map((peer) => (
                  <div
                    key={peer.id}
                    className="bg-zinc-950/80 border border-zinc-800 p-2.5 rounded-xl flex items-center space-x-2 space-x-reverse"
                  >
                    {peer.photo_b64 ? (
                      <img src={peer.photo_b64} className="mx-2 w-7 h-7 rounded-full object-cover" alt="Peer Avatar" />
                    ) : (
                      <div
                        className="mx-2 w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold"
                        style={{ backgroundColor: peer.color || '#374151' }}
                      >
                        {peer.name.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <span className="text-xs text-zinc-200 truncate">{peer.name}</span>
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={() => setShowAccountModal(false)}
              className="w-full bg-zinc-800 text-zinc-200 text-xs py-2.5 rounded-xl hover:bg-zinc-700 transition-colors shrink-0"
            >
              بستن
            </button>
          </div>
        </div>
      )}

      {/* Candidate Voting Poll Modal */}
      {poll && poll.active && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 w-full max-w-xs space-y-4 text-center">
            <h3 className="text-sm font-bold text-zinc-100">درخواست پیوستن به گروه</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              کاربر <span className="text-zinc-100 font-bold">{poll.candidate_name}</span> می‌خواهد وارد اتاق شود. (نیازمند کسب ۷۰٪ رای مثبت)
            </p>
            <div dir="ltr" className="text-xs font-mono text-zinc-500">
              Votes: {poll.yes_votes} / {poll.total_votes}
            </div>
            <div className="flex space-x-2 space-x-reverse pt-2">
              <button
                onClick={() => handleVote(true)}
                className="flex-1 bg-zinc-100 text-zinc-950 font-bold text-xs py-2.5 rounded-xl hover:bg-zinc-300 transition-colors"
              >
                قبول (+1)
              </button>
              <button
                onClick={() => handleVote(false)}
                className="flex-1 bg-zinc-800 text-zinc-300 text-xs py-2.5 rounded-xl hover:bg-zinc-700 transition-colors"
              >
                رد
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Memoized Chat Message Item
const ChatMessageItem = memo(({ message, isMe }: { message: ChatMessage; isMe: boolean }) => {
  const formattedTime = useMemo(() => {
    return new Date(message.timestamp).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }, [message.timestamp]);

  return (
    <div className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} mb-1`}>
      <div
        className={`max-w-[85%] md:max-w-[65%] px-3.5 py-2 rounded-2xl shadow-sm text-sm ${
          isMe
            ? 'bg-zinc-800 text-zinc-100 rounded-br-none'
            : 'bg-zinc-900 border border-zinc-800/80 text-zinc-200 rounded-bl-none'
        }`}
      >
        {!isMe && (
          <span className="block text-[10px] text-zinc-400 font-bold mb-0.5">
            {message.sender_name}
          </span>
        )}

        {message.msg_type === 'image' ? (
          <img
            src={message.content}
            alt="Shared WebP"
            className="rounded-xl max-w-full max-h-80 object-cover my-1"
            loading="lazy"
          />
        ) : (
          <ParsedMessageContent content={message.content} />
        )}

        <span dir="ltr" className="block text-[9px] text-zinc-500 text-left mt-1 font-mono ltr-code">
          {formattedTime}
        </span>
      </div>
    </div>
  );
});

// Memoized BIDI Content Parser
const ParsedMessageContent = memo(({ content }: { content: string }) => {
  const parts = useMemo(() => content.split(/(```[\s\S]*?```)/g), [content]);

  return (
    <div className="space-y-1">
      {parts.map((part, idx) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          return <CollapsibleCode key={idx} block={part} />;
        }

        const subParts = part.split(/(`[^`]+`)/g);

        return (
          <p
            key={idx}
            dir="auto"
            className="whitespace-pre-wrap leading-relaxed"
            style={{ unicodeBidi: 'plaintext' }}
          >
            {subParts.map((sub, sIdx) => {
              if (sub.startsWith('`') && sub.endsWith('`') && sub.length > 2) {
                return (
                  <code
                    key={sIdx}
                    dir="ltr"
                    className="bg-zinc-950 border border-zinc-800 text-zinc-300 font-mono text-[11px] px-1.5 py-0.5 rounded inline-block mx-0.5 ltr-code"
                  >
                    {sub.slice(1, -1)}
                  </code>
                );
              }
              return sub;
            })}
          </p>
        );
      })}
    </div>
  );
});

// Collapsible Code Block
const CollapsibleCode = memo(({ block }: { block: string }) => {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  const { language, cleanCode } = useMemo(() => {
    const match = block.match(/^```(\w+)?\n?([\s\S]*?)```$/);
    return {
      language: match?.[1] ? match[1].toUpperCase() : 'CODE',
      cleanCode: match?.[2] ? match[2].trim() : block.replace(/^```\w*\n?/, '').replace(/```$/, '').trim(),
    };
  }, [block]);

  const copyCode = useCallback(() => {
    navigator.clipboard.writeText(cleanCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [cleanCode]);

  return (
    <div dir="ltr" className="my-1.5 bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden font-mono ltr-code">
      <div className="bg-zinc-900/90 px-3 py-1.5 flex items-center justify-between text-xs border-b border-zinc-800/60 select-none">
        <span className="text-zinc-400 text-[10px] font-bold tracking-wider">{language}</span>
        <div className="flex items-center space-x-2">
          <button onClick={copyCode} className="text-zinc-400 hover:text-zinc-200 transition-colors">
            {copied ? <span className="text-[10px] text-zinc-300">Copied!</span> : <Icons.Copy />}
          </button>
          <button onClick={() => setOpen((prev) => !prev)} className="text-zinc-400 hover:text-zinc-200 transition-colors">
            {open ? <Icons.ChevronUp /> : <Icons.ChevronDown />}
          </button>
        </div>
      </div>
      {open && (
        <pre className="p-3 text-xs text-zinc-300 overflow-x-auto leading-relaxed">
          <code>{cleanCode}</code>
        </pre>
      )}
    </div>
  );
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);