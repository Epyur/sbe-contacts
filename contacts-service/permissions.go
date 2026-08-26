package main

import (
	"log"
	"net/http"
	"os"
	"strings"
)

func ownerEmailFromEnv() string {
	return os.Getenv("CONTACTS_OWNER_EMAIL")
}

// handleMyPermission возвращает роль текущего пользователя (по JWT email).
func (s *Server) handleMyPermission(w http.ResponseWriter, r *http.Request) {
	email, ok := r.Context().Value(permEmailCtx{}).(string)
	if !ok || email == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	role, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if role == "" {
		writeJSON(w, http.StatusOK, map[string]any{"email": email, "role": "", "hasAccess": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"email": email, "role": role, "hasAccess": true})
}

// handleListPermissions возвращает все права (для admin).
func (s *Server) handleListPermissions(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
SELECT email, role FROM contacts_permissions WHERE app = $1 ORDER BY email`, appIDFromEnv())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	type perm struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	perms := make([]perm, 0, 16)
	for rows.Next() {
		var p perm
		if err := rows.Scan(&p.Email, &p.Role); err != nil {
			log.Printf("permissions scan: %v", err)
			continue
		}
		perms = append(perms, p)
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"permissions": perms})
}

// handleSetPermission устанавливает роль ({email, role}); role="" — удаляет доступ.
func (s *Server) handleSetPermission(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Email = strings.TrimSpace(req.Email)
	req.Role = strings.TrimSpace(req.Role)
	if req.Email == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "email is required"})
		return
	}
	if req.Role != "" && req.Role != "viewer" && req.Role != "commenter" && req.Role != "editor" && req.Role != "admin" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "role must be viewer, commenter, editor or admin"})
		return
	}

	if req.Role == "" || req.Role != "admin" {
		owner := ownerEmailFromEnv()
		if req.Email == owner {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "нельзя отозвать доступ владельца"})
			return
		}
	}

	var err error
	if req.Role == "" {
		_, err = s.pool.Exec(r.Context(), `
DELETE FROM contacts_permissions WHERE app = $1 AND email = $2`, appIDFromEnv(), req.Email)
	} else {
		_, err = s.pool.Exec(r.Context(), `
INSERT INTO contacts_permissions (app, email, role) VALUES ($1, $2, $3)
ON CONFLICT (app, email) DO UPDATE SET role = EXCLUDED.role`,
			appIDFromEnv(), req.Email, req.Role)
	}
	if err != nil {
		log.Printf("set permission: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleGetCommonAccess возвращает уровень общего доступа.
func (s *Server) handleGetCommonAccess(w http.ResponseWriter, r *http.Request) {
	var level string
	err := s.pool.QueryRow(r.Context(),
		`SELECT level FROM contacts_common_access WHERE app = $1`, appIDFromEnv()).Scan(&level)
	if err != nil {
		level = ""
	}
	writeJSON(w, http.StatusOK, map[string]any{"level": level})
}

// handleSetCommonAccess устанавливает уровень общего доступа ({level}).
func (s *Server) handleSetCommonAccess(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Level string `json:"level"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Level = strings.TrimSpace(req.Level)
	if req.Level != "" && req.Level != "viewer" && req.Level != "commenter" && req.Level != "editor" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "level must be viewer, commenter, editor or empty"})
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
INSERT INTO contacts_common_access (app, level) VALUES ($1, $2)
ON CONFLICT (app) DO UPDATE SET level = EXCLUDED.level`, appIDFromEnv(), req.Level); err != nil {
		log.Printf("set common access: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
