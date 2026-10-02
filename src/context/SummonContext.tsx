import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Summon, MetricSummary, WitnessPerson } from '../types';
import { useAuth } from './AuthContext';
import { requestPushPermissionAndSubscribe } from '../services/fcmService';
import { apiFetch } from '../services/apiClient';
import {
  db,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
} from '../services/firebase';

interface SummonContextType {
  summons: Summon[];
  isLoading: boolean;
  metrics: MetricSummary;
  addSummon: (
    summonData: Omit<Summon, 'id' | 'userId' | 'createdAt' | 'updatedAt'>,
    attachmentFile?: File | Blob | null
  ) => Promise<Summon>;
  updateSummon: (id: string, updates: Partial<Summon>, attachmentFile?: File | Blob | null, fileName?: string) => Promise<void>;
  deleteSummon: (id: string) => Promise<void>;
  markAsServed: (id: string, notes?: string) => Promise<void>;
  toggleReminder: (id: string) => Promise<void>;
  getSummonById: (id: string) => Summon | undefined;
  uploadAttachment: (summonId: string, fileOrDataUrl: string | File, fileName: string) => Promise<string>;
  witnesses: WitnessPerson[];
  isLoadingWitnesses: boolean;
  addWitness: (
    witnessData: Omit<WitnessPerson, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ) => Promise<WitnessPerson>;
  updateWitness: (id: string, updates: Partial<WitnessPerson>) => Promise<void>;
  deleteWitness: (id: string) => Promise<void>;
  getWitnessById: (id: string) => WitnessPerson | undefined;
}

const SummonContext = createContext<SummonContextType | undefined>(undefined);

export const SummonProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentUser } = useAuth();

  const currentUid = currentUser?.uid || null;

  // Initialize state from UID-scoped local storage if available for instant hydration
  const [summons, setSummons] = useState<Summon[]>(() => {
    if (typeof window !== 'undefined' && currentUid) {
      try {
        const cached = localStorage.getItem(`summons_cache_${currentUid}`);
        if (cached) return JSON.parse(cached);
      } catch (_) {}
    }
    return [];
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Witnesses state
  const [witnesses, setWitnesses] = useState<WitnessPerson[]>(() => {
    if (typeof window !== 'undefined' && currentUid) {
      try {
        const cached = localStorage.getItem(`witnesses_cache_${currentUid}`);
        if (cached) return JSON.parse(cached);
      } catch (_) {}
    }
    return [];
  });
  const [isLoadingWitnesses, setIsLoadingWitnesses] = useState<boolean>(true);

  const activeUidRef = useRef<string | null>(null);

  // Synchronize UID-scoped local storage cache
  const saveSummonsCache = useCallback((uid: string, data: Summon[]) => {
    try {
      if (typeof window !== 'undefined' && uid) {
        localStorage.setItem(`summons_cache_${uid}`, JSON.stringify(data));
      }
    } catch (_) {}
  }, []);

  const saveWitnessesCache = useCallback((uid: string, data: WitnessPerson[]) => {
    try {
      if (typeof window !== 'undefined' && uid) {
        localStorage.setItem(`witnesses_cache_${uid}`, JSON.stringify(data));
      }
    } catch (_) {}
  }, []);

  // Real-time Firestore synchronization for Summons & Witnesses scoped strictly to currentUser.uid
  useEffect(() => {
    let isMounted = true;
    let unsubSummons: (() => void) | null = null;
    let unsubWitnesses: (() => void) | null = null;

    if (!currentUser || !currentUser.uid) {
      activeUidRef.current = null;
      setSummons([]);
      setWitnesses([]);
      setIsLoading(false);
      setIsLoadingWitnesses(false);
      return;
    }

    const uid = currentUser.uid;
    activeUidRef.current = uid;

    // Load from local storage cache first for instant render
    try {
      const cachedSummons = localStorage.getItem(`summons_cache_${uid}`);
      if (cachedSummons) {
        const parsed = JSON.parse(cachedSummons);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setSummons(parsed);
          setIsLoading(false);
        }
      }
      const cachedWitnesses = localStorage.getItem(`witnesses_cache_${uid}`);
      if (cachedWitnesses) {
        const parsedWit = JSON.parse(cachedWitnesses);
        if (Array.isArray(parsedWit) && parsedWit.length > 0) {
          setWitnesses(parsedWit);
          setIsLoadingWitnesses(false);
        }
      }
    } catch (_) {}

    setIsLoading(true);
    setIsLoadingWitnesses(true);

    // Initial backend fast-fetch to populate state immediately without waiting on Firestore connection
    const loadBackendData = async () => {
      try {
        const [apiSummons, apiWitnesses] = await Promise.all([
          apiFetch<Summon[]>('/api/summons').catch((e) => {
            console.warn('[SummonContext] summons fast-fetch error:', e);
            return [];
          }),
          apiFetch<WitnessPerson[]>('/api/witnesses').catch((e) => {
            console.warn('[SummonContext] witnesses fast-fetch error:', e);
            return [];
          }),
        ]);

        if (!isMounted || activeUidRef.current !== uid) return;

        if (Array.isArray(apiSummons) && apiSummons.length > 0) {
          setSummons((prev) => {
            const combined = apiSummons;
            saveSummonsCache(uid, combined);
            return combined;
          });
          setIsLoading(false);
        }

        if (Array.isArray(apiWitnesses) && apiWitnesses.length > 0) {
          setWitnesses((prev) => {
            const combined = apiWitnesses;
            saveWitnessesCache(uid, combined);
            return combined;
          });
          setIsLoadingWitnesses(false);
        }
      } catch (e) {
        console.warn('[SummonContext] Initial backend fast-fetch notice:', e);
      }
    };

    loadBackendData();

    // Safety fallback timer: Ensure loading spinners complete within 2.5s
    const safetyTimer = setTimeout(() => {
      if (isMounted && activeUidRef.current === uid) {
        setIsLoading(false);
        setIsLoadingWitnesses(false);
      }
    }, 2500);

    try {
      // 1. Subscribe to real-time Firestore collection: users/{uid}/summons
      const summonsColRef = collection(db, 'users', uid, 'summons');
      unsubSummons = onSnapshot(
        summonsColRef,
        (snapshot) => {
          if (!isMounted || activeUidRef.current !== uid) return;

          const loadedSummons: Summon[] = [];
          snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            loadedSummons.push({
              ...(data as Summon),
              id: docSnap.id,
              userId: uid,
            });
          });

          // Sort chronologically by createdAt descending
          loadedSummons.sort((a, b) => {
            const timeA = new Date(a.createdAt || a.issueDate || '').getTime() || 0;
            const timeB = new Date(b.createdAt || b.issueDate || '').getTime() || 0;
            return timeB - timeA;
          });

          if (loadedSummons.length > 0) {
            setSummons(loadedSummons);
            saveSummonsCache(uid, loadedSummons);
            setIsLoading(false);
          } else {
            // If Firestore summons is empty, check if backend or cache has data to preserve and migrate
            fetch('/api/summons', { credentials: 'include' })
              .then((res) => (res.ok ? res.json() : []))
              .then(async (legacySummons: Summon[]) => {
                if (!isMounted || activeUidRef.current !== uid) return;
                if (legacySummons && legacySummons.length > 0) {
                  setSummons(legacySummons);
                  saveSummonsCache(uid, legacySummons);
                  console.info(`[SummonContext] Preserved & Migrating ${legacySummons.length} summons to Firestore for UID: ${uid}`);
                  const migrationPromises = legacySummons.map((s) => {
                    const sId = s.id || ('sum_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6));
                    const docToMigrate = { ...s, id: sId, userId: uid };
                    return setDoc(doc(db, 'users', uid, 'summons', sId), docToMigrate, { merge: true }).catch(() => {});
                  });
                  await Promise.allSettled(migrationPromises);
                } else {
                  // Only if both Firestore and Backend confirm 0 items, check if local cache had anything
                  setSummons((prev) => {
                    if (prev.length > 0) {
                      // Migrate current in-memory items to Firestore
                      prev.forEach((s) => {
                        const sId = s.id || ('sum_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6));
                        setDoc(doc(db, 'users', uid, 'summons', sId), { ...s, id: sId, userId: uid }, { merge: true }).catch(() => {});
                      });
                      return prev;
                    }
                    return [];
                  });
                }
              })
              .catch(() => {})
              .finally(() => {
                if (isMounted) setIsLoading(false);
              });
          }
        },
        async (error) => {
          console.warn('[SummonContext] Firestore summons listener notice:', error.message || error);
          // Fallback to backend API if Firestore encounters any permission / offline block
          try {
            const res = await fetch('/api/summons', { credentials: 'include' });
            if (res.ok && isMounted && activeUidRef.current === uid) {
              const data = await res.json();
              if (Array.isArray(data) && data.length > 0) {
                setSummons(data);
                saveSummonsCache(uid, data);
              }
            }
          } catch (fetchErr) {
            console.warn('[SummonContext] API fallback error:', fetchErr);
          } finally {
            if (isMounted) setIsLoading(false);
          }
        }
      );

      // 2. Subscribe to real-time Firestore collection: users/{uid}/witnesses
      const witnessesColRef = collection(db, 'users', uid, 'witnesses');
      unsubWitnesses = onSnapshot(
        witnessesColRef,
        (snapshot) => {
          if (!isMounted || activeUidRef.current !== uid) return;

          const loadedWitnesses: WitnessPerson[] = [];
          snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            loadedWitnesses.push({
              ...(data as WitnessPerson),
              id: docSnap.id,
              userId: uid,
            });
          });

          loadedWitnesses.sort((a, b) => {
            const timeA = new Date(a.createdAt || '').getTime() || 0;
            const timeB = new Date(b.createdAt || '').getTime() || 0;
            return timeB - timeA;
          });

          if (loadedWitnesses.length > 0) {
            setWitnesses(loadedWitnesses);
            saveWitnessesCache(uid, loadedWitnesses);
            setIsLoadingWitnesses(false);
          } else {
            fetch('/api/witnesses', { credentials: 'include' })
              .then((res) => (res.ok ? res.json() : []))
              .then(async (legacyWitnesses: WitnessPerson[]) => {
                if (!isMounted || activeUidRef.current !== uid) return;
                if (legacyWitnesses && legacyWitnesses.length > 0) {
                  setWitnesses(legacyWitnesses);
                  saveWitnessesCache(uid, legacyWitnesses);
                  const migrationPromises = legacyWitnesses.map((w) => {
                    const wId = w.id || ('wit_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6));
                    return setDoc(doc(db, 'users', uid, 'witnesses', wId), { ...w, id: wId, userId: uid }, { merge: true }).catch(() => {});
                  });
                  await Promise.allSettled(migrationPromises);
                } else {
                  setWitnesses((prev) => {
                    if (prev.length > 0) {
                      prev.forEach((w) => {
                        const wId = w.id || ('wit_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6));
                        setDoc(doc(db, 'users', uid, 'witnesses', wId), { ...w, id: wId, userId: uid }, { merge: true }).catch(() => {});
                      });
                      return prev;
                    }
                    return [];
                  });
                }
              })
              .catch(() => {})
              .finally(() => {
                if (isMounted) setIsLoadingWitnesses(false);
              });
          }
        },
        async (error) => {
          console.warn('[SummonContext] Firestore witnesses listener notice:', error.message || error);
          try {
            const res = await fetch('/api/witnesses', { credentials: 'include' });
            if (res.ok && isMounted && activeUidRef.current === uid) {
              const data = await res.json();
              if (Array.isArray(data) && data.length > 0) {
                setWitnesses(data);
                saveWitnessesCache(uid, data);
              }
            }
          } catch (fetchErr) {
            console.warn('[SummonContext] Witnesses API fallback error:', fetchErr);
          } finally {
            if (isMounted) setIsLoadingWitnesses(false);
          }
        }
      );
    } catch (err) {
      console.error('[SummonContext] Setup Firestore subscription error:', err);
      setIsLoading(false);
      setIsLoadingWitnesses(false);
    }

    return () => {
      isMounted = false;
      clearTimeout(safetyTimer);
      if (unsubSummons) unsubSummons();
      if (unsubWitnesses) unsubWitnesses();
    };
  }, [currentUser, saveSummonsCache, saveWitnessesCache]);

  const uploadAttachment = async (
    summonId: string,
    fileOrDataUrl: string | File,
    fileName: string
  ): Promise<string> => {
    if (typeof fileOrDataUrl === 'string' && fileOrDataUrl.startsWith('http')) {
      return fileOrDataUrl;
    }

    try {
      const { storage, storageRef, uploadBytes, getDownloadURL, isFirebaseConfigured } = await import('../services/firebase');
      
      let fileToUpload: File | Blob;
      if (typeof fileOrDataUrl === 'string') {
        const res = await fetch(fileOrDataUrl);
        fileToUpload = await res.blob();
      } else {
        fileToUpload = fileOrDataUrl;
      }

      if (!isFirebaseConfigured || !storage) {
        throw new Error('Firebase Storage not configured, falling back to local base64.');
      }

      const fileRef = storageRef(storage, `summons/${currentUser?.uid}/${summonId}_${fileName}`);
      
      // Add timeout to prevent hanging
      const uploadPromise = uploadBytes(fileRef, fileToUpload);
      const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Upload timeout')), 10000));
      
      await Promise.race([uploadPromise, timeoutPromise]);
      const downloadURL = await getDownloadURL(fileRef);
      return downloadURL;
    } catch (err) {
      console.warn('Failed to upload attachment, falling back to data URL:', err);
      // Fallback to dataURL if upload fails
      if (typeof fileOrDataUrl === 'string') return fileOrDataUrl;
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string) || '');
        reader.readAsDataURL(fileOrDataUrl);
      });
    }
  };

  const addSummon = async (
    summonData: Omit<Summon, 'id' | 'userId' | 'createdAt' | 'updatedAt'>,
    attachmentFile?: File | Blob | null
  ): Promise<Summon> => {
    if (!currentUser || !currentUser.uid) throw new Error('User must be authenticated to add summons');
    
    const now = new Date().toISOString();
    const summonId = 'sum_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);

    let finalImageUrl = summonData.imageUrl;
    let finalPdfUrl = summonData.pdfUrl;

    if (attachmentFile && summonData.fileName) {
      const dataUrl = await uploadAttachment(summonId, attachmentFile as File, summonData.fileName);
      if (summonData.fileName.toLowerCase().endsWith('.pdf')) {
        finalPdfUrl = dataUrl;
      } else {
        finalImageUrl = dataUrl;
      }
    }

    const newSummon: Summon = {
      ...summonData,
      imageUrl: finalImageUrl,
      pdfUrl: finalPdfUrl,
      id: summonId,
      userId: currentUser.uid,
      createdAt: now,
      updatedAt: now,
    };

    // 1. Primary write to Firestore under users/{uid}/summons/{summonId}
    try {
      const docRef = doc(db, 'users', currentUser.uid, 'summons', summonId);
      await setDoc(docRef, newSummon);
    } catch (fsErr) {
      console.warn('[SummonContext] Firestore addSummon notice:', fsErr);
    }

    // 2. Synchronize with backend API endpoint & MongoDB database
    try {
      await apiFetch('/api/summons', {
        method: 'POST',
        body: JSON.stringify(newSummon),
      });
      console.info(`[SummonContext] Successfully persisted summons '${summonId}' to MongoDB.`);
    } catch (apiErr: any) {
      console.error('[SummonContext] Backend MongoDB addSummon error:', apiErr?.message || apiErr);
    }

    // Local state is updated via Firestore onSnapshot, but update immediately for instant responsiveness
    setSummons((prev) => {
      const updated = [newSummon, ...prev.filter((s) => s.id !== summonId)];
      if (currentUser?.uid) saveSummonsCache(currentUser.uid, updated);
      return updated;
    });

    return newSummon;
  };

  const updateSummon = async (id: string, updates: Partial<Summon>, attachmentFile?: File | Blob | null, fileName?: string) => {
    if (!currentUser || !currentUser.uid) return;
    const now = new Date().toISOString();
    let finalImageUrl = updates.imageUrl;
    let finalPdfUrl = updates.pdfUrl;
    if (attachmentFile && fileName) {
      const dataUrl = await uploadAttachment(id, attachmentFile as File, fileName);
      if (fileName.toLowerCase().endsWith('.pdf')) {
        finalPdfUrl = dataUrl;
      } else {
        finalImageUrl = dataUrl;
      }
    }
    const updatedRecord = {
      ...updates,
      updatedAt: now,
      ...(finalImageUrl !== undefined && { imageUrl: finalImageUrl }),
      ...(finalPdfUrl !== undefined && { pdfUrl: finalPdfUrl })
    };

    // 1. Update in Firestore under users/{uid}/summons/{id}
    try {
      const docRef = doc(db, 'users', currentUser.uid, 'summons', id);
      await setDoc(docRef, updatedRecord, { merge: true });
    } catch (fsErr) {
      console.warn('[SummonContext] Firestore updateSummon notice:', fsErr);
    }

    // 2. Synchronize with backend API & MongoDB
    try {
      await apiFetch(`/api/summons/${id}`, {
        method: 'PUT',
        body: JSON.stringify(updatedRecord),
      });
      console.info(`[SummonContext] Successfully updated summons '${id}' in MongoDB.`);
    } catch (apiErr: any) {
      console.error('[SummonContext] Backend MongoDB updateSummon error:', apiErr?.message || apiErr);
    }

    setSummons((prev) => {
      const updated = prev.map((s) => (s.id === id ? { ...s, ...updatedRecord } : s));
      if (currentUser?.uid) saveSummonsCache(currentUser.uid, updated);
      return updated;
    });
  };

  const deleteSummon = async (id: string) => {
    if (!currentUser || !currentUser.uid) return;
    try {
      const summonToDelete = summons.find(s => s.id === id);

      // 1. Delete from Firestore under users/{uid}/summons/{id}
      try {
        const docRef = doc(db, 'users', currentUser.uid, 'summons', id);
        await deleteDoc(docRef);
      } catch (fsErr) {
        console.warn('[SummonContext] Firestore deleteSummon notice:', fsErr);
      }

      // 2. Delete from backend API & MongoDB
      try {
        await apiFetch(`/api/summons/${id}`, {
          method: 'DELETE',
        });
        console.info(`[SummonContext] Successfully deleted summons '${id}' in MongoDB.`);
      } catch (apiErr: any) {
        console.error('[SummonContext] Backend MongoDB deleteSummon error:', apiErr?.message || apiErr);
      }

      if (summonToDelete) {
        try {
          const { storage, deleteObject, storageRef, isFirebaseConfigured } = await import('../services/firebase');
          if (isFirebaseConfigured && storage) {
            if (summonToDelete.imageUrl && summonToDelete.imageUrl.includes('firebasestorage.googleapis.com')) {
               const fileRef = storageRef(storage, summonToDelete.imageUrl);
               await deleteObject(fileRef).catch(() => {});
            }
            if (summonToDelete.pdfUrl && summonToDelete.pdfUrl.includes('firebasestorage.googleapis.com')) {
               const fileRef = storageRef(storage, summonToDelete.pdfUrl);
               await deleteObject(fileRef).catch(() => {});
            }
          }
        } catch (e) {}
      }

      setSummons((prev) => {
        const updated = prev.filter((s) => s.id !== id);
        if (currentUser?.uid) saveSummonsCache(currentUser.uid, updated);
        return updated;
      });
    } catch (err) {
      console.error("Failed to delete summon:", err);
      throw err;
    }
  };

  const markAsServed = async (id: string, notes?: string) => {
    const today = new Date().toISOString().split('T')[0];
    await updateSummon(id, {
      status: 'Completed',
      servedDate: today,
      servedNotes: notes || 'Summon served in person. Official receipt signed by recipient.',
    });
  };

  const toggleReminder = async (id: string) => {
    const target = summons.find((s) => s.id === id);
    if (!target) return;
    if (!target.reminderEnabled) {
      await requestPushPermissionAndSubscribe().catch(() => {});
    }
    await updateSummon(id, {
      reminderEnabled: !target.reminderEnabled,
    });
  };

  const getSummonById = (id: string) => summons.find((s) => s.id === id);

  const addWitness = async (
    witnessData: Omit<WitnessPerson, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<WitnessPerson> => {
    if (!currentUser || !currentUser.uid) throw new Error('User must be authenticated to add witnesses');
    const now = new Date().toISOString();
    const witnessId = 'wit_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);

    const newWitness: WitnessPerson = {
      ...witnessData,
      id: witnessId,
      userId: currentUser.uid,
      createdAt: now,
      updatedAt: now,
    };

    // 1. Write to Firestore users/{uid}/witnesses/{witnessId}
    try {
      const docRef = doc(db, 'users', currentUser.uid, 'witnesses', witnessId);
      await setDoc(docRef, newWitness);
    } catch (fsErr) {
      console.warn('[SummonContext] Firestore addWitness notice:', fsErr);
    }

    // 2. Write to backend API & MongoDB
    try {
      await apiFetch('/api/witnesses', {
        method: 'POST',
        body: JSON.stringify(newWitness),
      });
      console.info(`[SummonContext] Successfully persisted witness '${witnessId}' to MongoDB.`);
    } catch (apiErr: any) {
      console.error('[SummonContext] Backend MongoDB addWitness error:', apiErr?.message || apiErr);
    }

    setWitnesses((prev) => {
      const updated = [newWitness, ...prev.filter((w) => w.id !== witnessId)];
      if (currentUser?.uid) saveWitnessesCache(currentUser.uid, updated);
      return updated;
    });

    return newWitness;
  };

  const updateWitness = async (id: string, updates: Partial<WitnessPerson>) => {
    if (!currentUser || !currentUser.uid) return;
    const now = new Date().toISOString();
    const updatedRecord = { ...updates, updatedAt: now };

    // 1. Update in Firestore
    try {
      const docRef = doc(db, 'users', currentUser.uid, 'witnesses', id);
      await setDoc(docRef, updatedRecord, { merge: true });
    } catch (fsErr) {
      console.warn('[SummonContext] Firestore updateWitness notice:', fsErr);
    }

    // 2. Update in backend API & MongoDB
    try {
      await apiFetch(`/api/witnesses/${id}`, {
        method: 'PUT',
        body: JSON.stringify(updatedRecord),
      });
      console.info(`[SummonContext] Successfully updated witness '${id}' in MongoDB.`);
    } catch (apiErr: any) {
      console.error('[SummonContext] Backend MongoDB updateWitness error:', apiErr?.message || apiErr);
    }

    setWitnesses((prev) => {
      const updated = prev.map((w) => (w.id === id ? { ...w, ...updatedRecord } : w));
      if (currentUser?.uid) saveWitnessesCache(currentUser.uid, updated);
      return updated;
    });
  };

  const deleteWitness = async (id: string) => {
    if (!currentUser || !currentUser.uid) return;
    try {
      // 1. Delete from Firestore
      try {
        const docRef = doc(db, 'users', currentUser.uid, 'witnesses', id);
        await deleteDoc(docRef);
      } catch (fsErr) {
        console.warn('[SummonContext] Firestore deleteWitness notice:', fsErr);
      }

      // 2. Delete from backend API & MongoDB
      try {
        await apiFetch(`/api/witnesses/${id}`, {
          method: 'DELETE',
        });
        console.info(`[SummonContext] Successfully deleted witness '${id}' in MongoDB.`);
      } catch (apiErr: any) {
        console.error('[SummonContext] Backend MongoDB deleteWitness error:', apiErr?.message || apiErr);
      }

      setWitnesses((prev) => {
        const updated = prev.filter((w) => w.id !== id);
        if (currentUser?.uid) saveWitnessesCache(currentUser.uid, updated);
        return updated;
      });
    } catch (err) {
      console.error("Failed to delete witness:", err);
      throw err;
    }
  };

  const getWitnessById = (id: string) => witnesses.find((w) => w.id === id);

  const metrics: MetricSummary = {
    total: summons.length,
    pending: summons.filter((s) => s.status === 'Pending').length,
    upcoming: summons.filter((s) => s.status === 'Upcoming').length,
    completed: summons.filter((s) => s.status === 'Completed').length,
  };

  return (
    <SummonContext.Provider
      value={{
        summons,
        isLoading,
        metrics,
        addSummon,
        updateSummon,
        deleteSummon,
        markAsServed,
        toggleReminder,
        getSummonById,
        uploadAttachment,
        witnesses,
        isLoadingWitnesses,
        addWitness,
        updateWitness,
        deleteWitness,
        getWitnessById,
      }}
    >
      {children}
    </SummonContext.Provider>
  );
};

export const useSummons = (): SummonContextType => {
  const context = useContext(SummonContext);
  if (!context) {
    throw new Error('useSummons must be used within a SummonProvider');
  }
  return context;
};

