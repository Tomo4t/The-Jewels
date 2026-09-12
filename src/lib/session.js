import api from './api.js';

/**
 * Who is signed in. One shared object the whole app reads, with a change event
 * so the navbar and the comment box stay in step without prop-drilling.
 */

const state = {
  user: null,
  registrationOpen: true,
  moderationQueue: true,
  loaded: false,
  apiAvailable: true,
};

const listeners = new Set();

const emit = () => {
  for (const listener of listeners) listener(state);
  document.dispatchEvent(new CustomEvent('sessionchange', { detail: { user: state.user } }));
};

export const session = {
  get user() {
    return state.user;
  },
  get isSignedIn() {
    return !!state.user;
  },
  get isModerator() {
    return state.user?.role === 'moderator' || state.user?.role === 'admin';
  },
  get isAdmin() {
    return state.user?.role === 'admin';
  },
  get registrationOpen() {
    return state.registrationOpen;
  },
  get moderationQueue() {
    return state.moderationQueue;
  },
  get apiAvailable() {
    return state.apiAvailable;
  },
  get loaded() {
    return state.loaded;
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  async refresh() {
    try {
      const data = await api.me();
      state.user = data.user;
      state.registrationOpen = data.registrationOpen !== false;
      state.moderationQueue = data.moderationQueue !== false;
      state.apiAvailable = true;
    } catch {
      // No backend (static hosting, or the server is down). Reading still works.
      state.user = null;
      state.apiAvailable = false;
    } finally {
      state.loaded = true;
      emit();
    }
    return state.user;
  },

  async signIn(username, password) {
    const data = await api.login(username, password);
    state.user = data.user;
    state.apiAvailable = true;
    emit();
    return state.user;
  },

  async signUp(payload) {
    const data = await api.register(payload);
    state.user = data.user;
    state.apiAvailable = true;
    emit();
    return state.user;
  },

  async signOut() {
    try {
      await api.logout();
    } finally {
      state.user = null;
      emit();
    }
  },
};

export default session;
