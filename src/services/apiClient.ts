import { auth } from './firebase';

/**
 * Returns authenticated headers including Bearer token if user is signed in with Firebase
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  try {
    const currentUser = auth.currentUser;
    if (currentUser) {
      const idToken = await currentUser.getIdToken();
      if (idToken) {
        headers['Authorization'] = `Bearer ${idToken}`;
      }
    }
  } catch (err) {
    console.warn('[ApiClient] Failed to acquire Firebase ID token:', err);
  }

  return headers;
}

/**
 * Robust, authenticated fetch wrapper for Summons Mitra backend API.
 * Ensures authorization header is attached, cookies are included, and errors are cleanly propagated.
 */
export async function apiFetch<T = any>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const authHeaders = await getAuthHeaders();
  const mergedHeaders = {
    ...authHeaders,
    ...((options.headers as Record<string, string>) || {}),
  };

  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: mergedHeaders,
  });

  if (!response.ok) {
    let errorMsg = `Server request to ${url} failed with status ${response.status}`;
    try {
      const errData = await response.json();
      if (errData && errData.error) {
        errorMsg = errData.error;
      }
    } catch (_) {
      try {
        const text = await response.text();
        if (text) errorMsg = text;
      } catch (_) {}
    }
    const error = new Error(errorMsg);
    (error as any).status = response.status;
    throw error;
  }

  // Handle empty 204 or empty response body
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return (await response.json()) as T;
  }
  return (await response.text()) as unknown as T;
}
