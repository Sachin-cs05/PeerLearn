import type {
  ApiResponse,
  ApiErrorResponse,
  HealthCheckData,
  AuthUser,
  RegisterInput,
  LoginInput,
  ResetPasswordInput,
  StudentProfileDto,
  UpdateProfileInput,
  SkillDto,
  SkillProficiency,
  GoalPriority,
  StudentSearchItem,
  PartnerRecommendation,
  FriendRequestDto,
  FriendConnectionDto,
  UserBlockDto,
  SavedPartnerDto,
  PaginatedResult,
  LearningSessionDto,
  CreateSessionInput,
  ProposeRescheduleInput,
  AvailabilityConflict,
  LearningResourceDto,
  CreateResourceInput,
  UpdateResourceInput,
  DashboardSummaryDto,
  CodeWorkspaceDto,
  CodeWorkspaceParticipantDto,
  CodeDocumentDto,
  DocumentRevisionDto,
  CreateCodeWorkspaceInput,
  UpdateCodeWorkspaceInput,
  AddWorkspaceParticipantInput,
  CreateCodeDocumentInput,
  UpdateCodeDocumentInput,
  WorkspaceRole,
  StudyRoomDto,
  StudyRoomParticipantDto,
  WhiteboardDocumentDto,
  WhiteboardRevisionDto,
  CreateStudyRoomInput,
  UpdateStudyRoomInput,
  AddStudyRoomParticipantInput,
  StudyRoomRole,
  GlobalSearchResponse,
  SearchEntityType,
  UserPreferencesDto,
  UpdateUserPreferencesInput,
} from '@peerlume/shared';

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

export interface ApiResult<T> {
  data: T | null;
  error: string | null;
  status: number;
}

let refreshPromise: Promise<boolean> | null = null;

async function tryRefreshToken(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });
        return res.ok;
      } catch {
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

export async function apiRequest<T>(
  endpoint: string,
  options?: RequestInit
): Promise<ApiResult<T>> {
  const url = `${API_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  try {
    let response = await fetch(url, {
      credentials: 'include', // Ensures HttpOnly cookies are transmitted
      headers: {
        ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...options?.headers,
      },
      ...options,
    });

    // Auto-refresh token if 401 Unauthorized (except on auth entrypoints)
    if (
      response.status === 401 &&
      !endpoint.includes('/auth/login') &&
      !endpoint.includes('/auth/refresh') &&
      !endpoint.includes('/auth/register') &&
      !endpoint.includes('/auth/logout')
    ) {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        response = await fetch(url, {
          credentials: 'include',
          headers: {
            ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
            ...options?.headers,
          },
          ...options,
        });
      }
    }

    const isJson = response.headers.get('content-type')?.includes('application/json');
    const body = isJson ? await response.json() : null;

    if (!response.ok) {
      const errorBody = body as ApiErrorResponse | null;
      const errorMessage =
        errorBody?.error?.message ||
        `Request failed with status ${response.status} (${response.statusText})`;

      return {
        data: null,
        error: errorMessage,
        status: response.status,
      };
    }

    const successBody = body as ApiResponse<T>;
    return {
      data: successBody ? successBody.data : null,
      error: null,
      status: response.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network connection error';
    return {
      data: null,
      error: message,
      status: 0,
    };
  }
}

export const apiService = {
  // System Health
  async getHealth(): Promise<ApiResult<HealthCheckData>> {
    return apiRequest<HealthCheckData>('/health');
  },

  // Authentication
  auth: {
    async register(input: RegisterInput): Promise<ApiResult<{ user: AuthUser }>> {
      return apiRequest<{ user: AuthUser }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async login(input: LoginInput): Promise<ApiResult<{ user: AuthUser }>> {
      return apiRequest<{ user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async logout(): Promise<ApiResult<null>> {
      return apiRequest<null>('/auth/logout', {
        method: 'POST',
      });
    },

    async getMe(): Promise<ApiResult<{ user: AuthUser }>> {
      return apiRequest<{ user: AuthUser }>('/auth/me');
    },

    async forgotPassword(email: string): Promise<ApiResult<null>> {
      return apiRequest<null>('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
    },

    async resetPassword(input: ResetPasswordInput): Promise<ApiResult<null>> {
      return apiRequest<null>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async verifyEmail(token: string): Promise<ApiResult<null>> {
      return apiRequest<null>('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
    },

    async resendVerification(email: string): Promise<ApiResult<null>> {
      return apiRequest<null>('/auth/resend-verification', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
    },
  },

  // Student Profiles
  profile: {
    async getMyProfile(): Promise<ApiResult<StudentProfileDto>> {
      return apiRequest<StudentProfileDto>('/profile/me');
    },

    async updateMyProfile(input: UpdateProfileInput): Promise<ApiResult<StudentProfileDto>> {
      return apiRequest<StudentProfileDto>('/profile/me', {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    },

    async getSkills(query?: string): Promise<ApiResult<SkillDto[]>> {
      const q = query ? `?q=${encodeURIComponent(query)}` : '';
      return apiRequest<SkillDto[]>(`/profile/skills${q}`);
    },

    async setTeachingSkills(
      skills: { name: string; category?: string; proficiency: SkillProficiency }[]
    ): Promise<ApiResult<StudentProfileDto>> {
      return apiRequest<StudentProfileDto>('/profile/teaching-skills', {
        method: 'PUT',
        body: JSON.stringify({ skills }),
      });
    },

    async setLearningGoals(
      goals: { name: string; category?: string; targetDescription?: string; priority: GoalPriority }[]
    ): Promise<ApiResult<StudentProfileDto>> {
      return apiRequest<StudentProfileDto>('/profile/learning-goals', {
        method: 'PUT',
        body: JSON.stringify({ goals }),
      });
    },
  },

  // Connections & Friends
  connections: {
    async sendRequest(receiverId: string, message?: string): Promise<ApiResult<{ status: string; message: string }>> {
      return apiRequest<{ status: string; message: string }>('/connections/requests', {
        method: 'POST',
        body: JSON.stringify({ receiverId, message }),
      });
    },

    async getIncomingRequests(): Promise<ApiResult<FriendRequestDto[]>> {
      return apiRequest<FriendRequestDto[]>('/connections/requests/incoming');
    },

    async getOutgoingRequests(): Promise<ApiResult<FriendRequestDto[]>> {
      return apiRequest<FriendRequestDto[]>('/connections/requests/outgoing');
    },

    async acceptRequest(requestId: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/connections/requests/${requestId}/accept`, {
        method: 'POST',
      });
    },

    async declineRequest(requestId: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/connections/requests/${requestId}/decline`, {
        method: 'POST',
      });
    },

    async cancelRequest(requestId: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/connections/requests/${requestId}`, {
        method: 'DELETE',
      });
    },

    async getFriends(search?: string): Promise<ApiResult<FriendConnectionDto[]>> {
      const query = search ? `?search=${encodeURIComponent(search)}` : '';
      return apiRequest<FriendConnectionDto[]>(`/connections${query}`);
    },

    async removeFriend(connectionId: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/connections/${connectionId}`, {
        method: 'DELETE',
      });
    },
  },

  // Discovery & Learning Partner Matching
  discovery: {
    async getRecommendedPartners(filters?: {
      q?: string;
      skill?: string;
      college?: string;
      branch?: string;
      semester?: string;
      language?: string;
      preferredMode?: string;
      page?: number;
      limit?: number;
    }): Promise<ApiResult<PaginatedResult<PartnerRecommendation>>> {
      const params = new URLSearchParams();
      if (filters?.q) params.set('q', filters.q);
      if (filters?.skill) params.set('skill', filters.skill);
      if (filters?.college) params.set('college', filters.college);
      if (filters?.branch) params.set('branch', filters.branch);
      if (filters?.semester) params.set('semester', filters.semester);
      if (filters?.language) params.set('language', filters.language);
      if (filters?.preferredMode) params.set('preferredMode', filters.preferredMode);
      if (filters?.page) params.set('page', filters.page.toString());
      if (filters?.limit) params.set('limit', filters.limit.toString());

      const qs = params.toString() ? `?${params.toString()}` : '';
      return apiRequest<PaginatedResult<PartnerRecommendation>>(`/discovery/partners${qs}`);
    },
  },

  // Student Search & Profiles
  students: {
    async search(filters?: {
      q?: string;
      college?: string;
      branch?: string;
      semester?: string;
      teachingSkill?: string;
      learningGoal?: string;
      page?: number;
      limit?: number;
    }): Promise<ApiResult<PaginatedResult<StudentSearchItem>>> {
      const params = new URLSearchParams();
      if (filters?.q) params.set('q', filters.q);
      if (filters?.college) params.set('college', filters.college);
      if (filters?.branch) params.set('branch', filters.branch);
      if (filters?.semester) params.set('semester', filters.semester);
      if (filters?.teachingSkill) params.set('teachingSkill', filters.teachingSkill);
      if (filters?.learningGoal) params.set('learningGoal', filters.learningGoal);
      if (filters?.page) params.set('page', filters.page.toString());
      if (filters?.limit) params.set('limit', filters.limit.toString());

      const qs = params.toString() ? `?${params.toString()}` : '';
      return apiRequest<PaginatedResult<StudentSearchItem>>(`/students${qs}`);
    },

    async getPublicDetails(studentId: string): Promise<ApiResult<StudentSearchItem>> {
      return apiRequest<StudentSearchItem>(`/students/${studentId}`);
    },
  },

  // User Blocking
  blocks: {
    async blockStudent(studentId: string, reason?: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/blocks/${studentId}`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
    },

    async unblockStudent(studentId: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/blocks/${studentId}`, {
        method: 'DELETE',
      });
    },

    async getBlockedStudents(): Promise<ApiResult<UserBlockDto[]>> {
      return apiRequest<UserBlockDto[]>('/blocks');
    },
  },

  // Saved Partners
  savedPartners: {
    async savePartner(studentId: string, notes?: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/saved-partners/${studentId}`, {
        method: 'POST',
        body: JSON.stringify({ notes }),
      });
    },

    async removeSavedPartner(studentId: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/saved-partners/${studentId}`, {
        method: 'DELETE',
      });
    },

    async getSavedPartners(): Promise<ApiResult<SavedPartnerDto[]>> {
      return apiRequest<SavedPartnerDto[]>('/saved-partners');
    },
  },

  // Chat Conversations & Messaging
  conversations: {
    async list(): Promise<ApiResult<any[]>> {
      return apiRequest<any[]>('/conversations');
    },

    async getOrCreateDirect(targetUserId: string): Promise<ApiResult<any>> {
      return apiRequest<any>('/conversations/direct', {
        method: 'POST',
        body: JSON.stringify({ targetUserId }),
      });
    },

    async getMessages(conversationId: string, limit = 40, before?: string): Promise<ApiResult<any[]>> {
      const params = new URLSearchParams();
      if (limit) params.set('limit', limit.toString());
      if (before) params.set('before', before);
      const qs = params.toString() ? `?${params.toString()}` : '';
      return apiRequest<any[]>(`/conversations/${conversationId}/messages${qs}`);
    },

    async sendMessage(
      conversationId: string,
      input: { content: string; type?: string; metadata?: any; clientTempId?: string }
    ): Promise<ApiResult<any>> {
      return apiRequest<any>(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async markAsRead(conversationId: string): Promise<ApiResult<{ markedCount: number; readAt: string }>> {
      return apiRequest<{ markedCount: number; readAt: string }>(`/conversations/${conversationId}/read`, {
        method: 'POST',
      });
    },
  },

  // Audio & Video Calling
  calls: {
    async initiate(receiverId: string, type: 'AUDIO' | 'VIDEO' = 'VIDEO'): Promise<ApiResult<any>> {
      return apiRequest<any>('/calls', {
        method: 'POST',
        body: JSON.stringify({ receiverId, type }),
      });
    },

    async get(callId: string): Promise<ApiResult<any>> {
      return apiRequest<any>(`/calls/${callId}`);
    },

    async end(callId: string): Promise<ApiResult<any>> {
      return apiRequest<any>(`/calls/${callId}/end`, {
        method: 'POST',
      });
    },

    async updateStatus(callId: string, status: string): Promise<ApiResult<any>> {
      return apiRequest<any>(`/calls/${callId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
    },

    async getIceConfig(): Promise<ApiResult<{ iceServers: any[] }>> {
      return apiRequest<{ iceServers: any[] }>('/calls/config');
    },
  },

  // Notifications
  notifications: {
    async list(page = 1, pageSize = 20, unreadOnly = false): Promise<ApiResult<any>> {
      const params = new URLSearchParams();
      params.set('page', page.toString());
      params.set('pageSize', pageSize.toString());
      if (unreadOnly) params.set('unreadOnly', 'true');
      return apiRequest<any>(`/notifications?${params.toString()}`);
    },

    async getUnreadCount(): Promise<ApiResult<{ unreadCount: number }>> {
      return apiRequest<{ unreadCount: number }>('/notifications/unread-count');
    },

    async markAsRead(notificationId: string): Promise<ApiResult<any>> {
      return apiRequest<any>(`/notifications/${notificationId}/read`, {
        method: 'PATCH',
      });
    },

    async markAllAsRead(): Promise<ApiResult<{ count: number }>> {
      return apiRequest<{ count: number }>('/notifications/read-all', {
        method: 'POST',
      });
    },
  },

  // Session Scheduling & Calendar
  sessions: {
    async create(input: CreateSessionInput): Promise<ApiResult<LearningSessionDto>> {
      return apiRequest<LearningSessionDto>('/sessions', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async list(params?: { status?: string; period?: 'upcoming' | 'past' }): Promise<ApiResult<LearningSessionDto[]>> {
      const q = new URLSearchParams();
      if (params?.status) q.set('status', params.status);
      if (params?.period) q.set('period', params.period);
      const queryStr = q.toString() ? `?${q.toString()}` : '';
      return apiRequest<LearningSessionDto[]>(`/sessions${queryStr}`);
    },

    async get(sessionId: string): Promise<ApiResult<LearningSessionDto>> {
      return apiRequest<LearningSessionDto>(`/sessions/${sessionId}`);
    },

    async accept(sessionId: string): Promise<ApiResult<LearningSessionDto>> {
      return apiRequest<LearningSessionDto>(`/sessions/${sessionId}/accept`, {
        method: 'POST',
      });
    },

    async decline(sessionId: string, reason?: string): Promise<ApiResult<LearningSessionDto>> {
      return apiRequest<LearningSessionDto>(`/sessions/${sessionId}/decline`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
    },

    async proposeReschedule(sessionId: string, input: ProposeRescheduleInput): Promise<ApiResult<any>> {
      return apiRequest<any>(`/sessions/${sessionId}/reschedule`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async respondReschedule(sessionId: string, proposalId: string, action: 'ACCEPT' | 'REJECT'): Promise<ApiResult<LearningSessionDto>> {
      return apiRequest<LearningSessionDto>(`/sessions/${sessionId}/reschedule/${proposalId}`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
    },

    async cancel(sessionId: string, reason?: string): Promise<ApiResult<LearningSessionDto>> {
      return apiRequest<LearningSessionDto>(`/sessions/${sessionId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
    },

    async complete(sessionId: string): Promise<ApiResult<LearningSessionDto>> {
      return apiRequest<LearningSessionDto>(`/sessions/${sessionId}/complete`, {
        method: 'POST',
      });
    },

    async checkAvailability(startTime: string, endTime: string, excludeSessionId?: string): Promise<ApiResult<AvailabilityConflict>> {
      const q = new URLSearchParams({ startTime, endTime });
      if (excludeSessionId) q.set('excludeSessionId', excludeSessionId);
      return apiRequest<AvailabilityConflict>(`/sessions/availability?${q.toString()}`);
    },

    async getCalendar(month?: number, year?: number): Promise<ApiResult<LearningSessionDto[]>> {
      const q = new URLSearchParams();
      if (month !== undefined) q.set('month', month.toString());
      if (year !== undefined) q.set('year', year.toString());
      const queryStr = q.toString() ? `?${q.toString()}` : '';
      return apiRequest<LearningSessionDto[]>(`/sessions/calendar${queryStr}`);
    },
  },

  // Knowledge-Sharing Workspace & Files
  resources: {
    async create(
      input: CreateResourceInput,
      file?: File,
      onProgress?: (percent: number) => void
    ): Promise<ApiResult<LearningResourceDto>> {
      if (file) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', input.type);
        formData.append('title', input.title);
        if (input.description) formData.append('description', input.description);
        if (input.content) formData.append('content', input.content);
        if (input.url) formData.append('url', input.url);
        if (input.language) formData.append('language', input.language);
        if (input.sessionId) formData.append('sessionId', input.sessionId);
        if (input.targetUserId) formData.append('targetUserId', input.targetUserId);
        if (input.isPrivate !== undefined) formData.append('isPrivate', String(input.isPrivate));

        if (onProgress && typeof XMLHttpRequest !== 'undefined') {
          return new Promise<ApiResult<LearningResourceDto>>((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_BASE_URL}/resources`);
            xhr.withCredentials = true;

            xhr.upload.onprogress = (event) => {
              if (event.lengthComputable) {
                const percent = Math.round((event.loaded / event.total) * 100);
                onProgress(percent);
              }
            };

            xhr.onload = () => {
              try {
                const json = JSON.parse(xhr.responseText);
                if (xhr.status >= 200 && xhr.status < 300) {
                  resolve({ data: json.data, error: null, status: xhr.status });
                } else {
                  resolve({ data: null, error: json.error?.message || 'Upload failed', status: xhr.status });
                }
              } catch {
                resolve({ data: null, error: 'Failed to process server response', status: xhr.status || 500 });
              }
            };

            xhr.onerror = () => {
              resolve({ data: null, error: 'Network error during upload', status: 0 });
            };

            xhr.send(formData);
          });
        }

        return apiRequest<LearningResourceDto>('/resources', {
          method: 'POST',
          body: formData,
        });
      }

      return apiRequest<LearningResourceDto>('/resources', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async list(filters?: { type?: string; notesOnly?: boolean; sessionId?: string }): Promise<ApiResult<LearningResourceDto[]>> {
      const q = new URLSearchParams();
      if (filters?.type) q.set('type', filters.type);
      if (filters?.notesOnly) q.set('notesOnly', 'true');
      if (filters?.sessionId) q.set('sessionId', filters.sessionId);
      const queryStr = q.toString() ? `?${q.toString()}` : '';
      return apiRequest<LearningResourceDto[]>(`/resources${queryStr}`);
    },

    async get(resourceId: string): Promise<ApiResult<LearningResourceDto>> {
      return apiRequest<LearningResourceDto>(`/resources/${resourceId}`);
    },

    async getSessionResources(sessionId: string): Promise<ApiResult<LearningResourceDto[]>> {
      return apiRequest<LearningResourceDto[]>(`/resources/session/${sessionId}`);
    },

    async update(resourceId: string, input: UpdateResourceInput): Promise<ApiResult<LearningResourceDto>> {
      return apiRequest<LearningResourceDto>(`/resources/${resourceId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    },

    async delete(resourceId: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/resources/${resourceId}`, {
        method: 'DELETE',
      });
    },

    getDownloadUrl(resourceId: string): string {
      return `${API_BASE_URL}/resources/${resourceId}/download`;
    },

    async downloadResource(
      resourceId: string,
      fileName?: string
    ): Promise<{ success: boolean; error?: string }> {
      const triggerDownload = (blob: Blob, name: string) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      };

      try {
        // Step 1: Request presigned download URL
        const presignedResult = await apiRequest<{ downloadUrl: string; expiresInSeconds: number }>(
          `/resources/${resourceId}/download?format=json`
        );

        if (presignedResult.data?.downloadUrl) {
          // Attempt download from the presigned URL
          const downloadRes = await fetch(presignedResult.data.downloadUrl);

          // If the presigned URL expired or failed (e.g. 403 from S3/R2), request ONE fresh URL
          if (!downloadRes.ok) {
            // Strictly 1 retry to prevent infinite loops; no logout triggered
            const freshResult = await apiRequest<{ downloadUrl: string; expiresInSeconds: number }>(
              `/resources/${resourceId}/download?format=json`
            );

            if (freshResult.data?.downloadUrl) {
              const retryRes = await fetch(freshResult.data.downloadUrl);
              if (retryRes.ok) {
                const blob = await retryRes.blob();
                triggerDownload(blob, fileName || 'download');
                return { success: true };
              }
            }
            return { success: false, error: 'Download link expired. Please retry.' };
          }

          const blob = await downloadRes.blob();
          triggerDownload(blob, fileName || 'download');
          return { success: true };
        }

        // Fallback: direct streaming endpoint via browser navigation
        window.open(`${API_BASE_URL}/resources/${resourceId}/download`, '_blank');
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message || 'Download failed' };
      }
    },
  },

  // Learning Dashboard
  dashboard: {
    async getSummary(): Promise<ApiResult<DashboardSummaryDto>> {
      return apiRequest<DashboardSummaryDto>('/dashboard/summary');
    },
  },

  // Collaborative Code Workspaces
  codeWorkspaces: {
    async list(): Promise<ApiResult<CodeWorkspaceDto[]>> {
      return apiRequest<CodeWorkspaceDto[]>('/code-workspaces');
    },

    async get(workspaceId: string): Promise<ApiResult<CodeWorkspaceDto>> {
      return apiRequest<CodeWorkspaceDto>(`/code-workspaces/${workspaceId}`);
    },

    async create(input: CreateCodeWorkspaceInput): Promise<ApiResult<CodeWorkspaceDto>> {
      return apiRequest<CodeWorkspaceDto>('/code-workspaces', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async update(workspaceId: string, input: UpdateCodeWorkspaceInput): Promise<ApiResult<CodeWorkspaceDto>> {
      return apiRequest<CodeWorkspaceDto>(`/code-workspaces/${workspaceId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    },

    async delete(workspaceId: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/code-workspaces/${workspaceId}`, {
        method: 'DELETE',
      });
    },

    async addParticipant(workspaceId: string, input: AddWorkspaceParticipantInput): Promise<ApiResult<CodeWorkspaceParticipantDto>> {
      return apiRequest<CodeWorkspaceParticipantDto>(`/code-workspaces/${workspaceId}/participants`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async updateParticipantRole(workspaceId: string, participantId: string, role: WorkspaceRole): Promise<ApiResult<CodeWorkspaceParticipantDto>> {
      return apiRequest<CodeWorkspaceParticipantDto>(`/code-workspaces/${workspaceId}/participants/${participantId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
    },

    async removeParticipant(workspaceId: string, participantId: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/code-workspaces/${workspaceId}/participants/${participantId}`, {
        method: 'DELETE',
      });
    },

    async createDocument(workspaceId: string, input: CreateCodeDocumentInput): Promise<ApiResult<CodeDocumentDto>> {
      return apiRequest<CodeDocumentDto>(`/code-workspaces/${workspaceId}/documents`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async updateDocument(workspaceId: string, documentId: string, input: UpdateCodeDocumentInput): Promise<ApiResult<CodeDocumentDto>> {
      return apiRequest<CodeDocumentDto>(`/code-workspaces/${workspaceId}/documents/${documentId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    },

    async deleteDocument(workspaceId: string, documentId: string): Promise<ApiResult<null>> {
      return apiRequest<null>(`/code-workspaces/${workspaceId}/documents/${documentId}`, {
        method: 'DELETE',
      });
    },

    async saveDocument(workspaceId: string, documentId: string, description?: string): Promise<ApiResult<{ version: number; savedAt: string }>> {
      return apiRequest<{ version: number; savedAt: string }>(`/code-workspaces/${workspaceId}/documents/${documentId}/save`, {
        method: 'POST',
        body: JSON.stringify({ description }),
      });
    },

    async listRevisions(workspaceId: string, documentId: string): Promise<ApiResult<DocumentRevisionDto[]>> {
      return apiRequest<DocumentRevisionDto[]>(`/code-workspaces/${workspaceId}/documents/${documentId}/revisions`);
    },

    async restoreRevision(workspaceId: string, documentId: string, revisionId: string): Promise<ApiResult<CodeDocumentDto>> {
      return apiRequest<CodeDocumentDto>(`/code-workspaces/${workspaceId}/documents/${documentId}/revisions/${revisionId}/restore`, {
        method: 'POST',
      });
    },
  },

  // Study Rooms & Collaborative Whiteboard
  studyRooms: {
    async list(params?: { sessionId?: string; activeOnly?: boolean; page?: number; limit?: number }): Promise<ApiResult<{ rooms: StudyRoomDto[]; total: number; page: number; limit: number }>> {
      const q = new URLSearchParams();
      if (params?.sessionId) q.set('sessionId', params.sessionId);
      if (params?.activeOnly !== undefined) q.set('activeOnly', String(params.activeOnly));
      if (params?.page) q.set('page', String(params.page));
      if (params?.limit) q.set('limit', String(params.limit));
      const queryStr = q.toString() ? `?${q.toString()}` : '';
      return apiRequest<{ rooms: StudyRoomDto[]; total: number; page: number; limit: number }>(`/study-rooms${queryStr}`);
    },

    async get(roomId: string): Promise<ApiResult<StudyRoomDto>> {
      return apiRequest<StudyRoomDto>(`/study-rooms/${roomId}`);
    },

    async create(input: CreateStudyRoomInput): Promise<ApiResult<StudyRoomDto>> {
      return apiRequest<StudyRoomDto>('/study-rooms', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async update(roomId: string, input: UpdateStudyRoomInput): Promise<ApiResult<StudyRoomDto>> {
      return apiRequest<StudyRoomDto>(`/study-rooms/${roomId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    },

    async join(roomId: string): Promise<ApiResult<StudyRoomDto>> {
      return apiRequest<StudyRoomDto>(`/study-rooms/${roomId}/join`, {
        method: 'POST',
      });
    },

    async leave(roomId: string): Promise<ApiResult<{ message: string }>> {
      return apiRequest<{ message: string }>(`/study-rooms/${roomId}/leave`, {
        method: 'POST',
      });
    },

    async end(roomId: string): Promise<ApiResult<{ message: string }>> {
      return apiRequest<{ message: string }>(`/study-rooms/${roomId}/end`, {
        method: 'POST',
      });
    },

    async addParticipant(roomId: string, input: AddStudyRoomParticipantInput): Promise<ApiResult<StudyRoomParticipantDto>> {
      return apiRequest<StudyRoomParticipantDto>(`/study-rooms/${roomId}/participants`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async updateParticipantRole(roomId: string, participantId: string, role: StudyRoomRole): Promise<ApiResult<StudyRoomParticipantDto>> {
      return apiRequest<StudyRoomParticipantDto>(`/study-rooms/${roomId}/participants/${participantId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
    },

    async removeParticipant(roomId: string, participantId: string): Promise<ApiResult<{ message: string }>> {
      return apiRequest<{ message: string }>(`/study-rooms/${roomId}/participants/${participantId}`, {
        method: 'DELETE',
      });
    },

    async getWhiteboard(roomId: string): Promise<ApiResult<WhiteboardDocumentDto>> {
      return apiRequest<WhiteboardDocumentDto>(`/study-rooms/${roomId}/board`);
    },

    async saveWhiteboard(roomId: string, description?: string): Promise<ApiResult<{ version: number; savedAt: string }>> {
      return apiRequest<{ version: number; savedAt: string }>(`/study-rooms/${roomId}/board/save`, {
        method: 'POST',
        body: JSON.stringify({ description }),
      });
    },

    async listRevisions(roomId: string): Promise<ApiResult<WhiteboardRevisionDto[]>> {
      return apiRequest<WhiteboardRevisionDto[]>(`/study-rooms/${roomId}/board/revisions`);
    },

    async restoreRevision(roomId: string, revisionId: string): Promise<ApiResult<{ elements: any[]; version: number }>> {
      return apiRequest<{ elements: any[]; version: number }>(`/study-rooms/${roomId}/board/revisions/${revisionId}/restore`, {
        method: 'POST',
      });
    },
  },

  // Global Search
  search: {
    async query(q: string, type: SearchEntityType = 'all', limit: number = 20): Promise<ApiResult<GlobalSearchResponse>> {
      const params = new URLSearchParams({ q, type, limit: String(limit) });
      return apiRequest<GlobalSearchResponse>(`/search?${params.toString()}`);
    },
  },

  // User Preferences
  preferences: {
    async get(): Promise<ApiResult<UserPreferencesDto>> {
      return apiRequest<UserPreferencesDto>('/preferences');
    },

    async update(input: UpdateUserPreferencesInput): Promise<ApiResult<UserPreferencesDto>> {
      return apiRequest<UserPreferencesDto>('/preferences', {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    },
  },

  // Calendar Export
  calendarExport: {
    getSessionExportUrl(sessionId: string): string {
      return `${API_BASE_URL}/sessions/${sessionId}/export.ics`;
    },
    getUserCalendarExportUrl(): string {
      return `${API_BASE_URL}/sessions/calendar/export.ics`;
    },
    async downloadSessionIcs(sessionId: string, sessionTitle?: string): Promise<void> {
      const url = `${API_BASE_URL}/sessions/${sessionId}/export.ics`;
      const token = localStorage.getItem('token');
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to export session calendar (.ics)');
      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      const safeTitle = (sessionTitle || 'session').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      a.download = `peerlearn_${safeTitle}.ics`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);
    },
    async downloadCalendarIcs(): Promise<void> {
      const url = `${API_BASE_URL}/sessions/calendar/export.ics`;
      const token = localStorage.getItem('token');
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to export calendar (.ics)');
      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = 'peerlearn_schedule.ics';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);
    },
  },
};

export const api = apiService;


