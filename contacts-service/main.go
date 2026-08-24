package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Contact struct {
	ID           int64  `json:"id"`
	Name         string `json:"name"`
	Phone        string `json:"phone"`
	Email        string `json:"email"`
	Organization string `json:"organization"`
	Position     string `json:"position"`
	OrgType      string `json:"org_type"`
	Notes        string `json:"notes"`
	CuratorEmail string `json:"curator_email"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

type PushRequest struct {
	Contacts []Contact `json:"contacts"`
}

type Server struct {
	pool *pgxpool.Pool
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	if err := loadJWTSecret(); err != nil {
		log.Fatalf("JWT: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("ping: %v", err)
	}

	s := &Server{pool: pool}

	if err := s.migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	if err := s.seedOwner(ctx); err != nil {
		log.Fatalf("seedOwner: %v", err)
	}
	regCtx, regCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer regCancel()
	if err := s.registerApp(regCtx); err != nil {
		log.Printf("registerApp (non-fatal): %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/contacts/health", s.handleHealth)
	mux.HandleFunc("POST /api/contacts/sync/push", s.requirePerm("editor")(s.handlePush))
	mux.HandleFunc("GET /api/contacts/sync/pull", s.requirePerm("viewer")(s.handlePull))
	mux.HandleFunc("POST /api/contacts/delete", s.requireDelete()(s.handleDelete))
	mux.HandleFunc("GET /api/contacts/permissions", s.requirePerm("admin")(s.handleListPermissions))
	mux.HandleFunc("POST /api/contacts/permissions", s.requirePerm("admin")(s.handleSetPermission))
	mux.HandleFunc("GET /api/contacts/permissions/me", s.requirePerm("viewer")(s.handleMyPermission))
	mux.HandleFunc("GET /api/contacts/common-access", s.requirePerm("admin")(s.handleGetCommonAccess))
	mux.HandleFunc("POST /api/contacts/common-access", s.requirePerm("admin")(s.handleSetCommonAccess))

	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("contacts-service listening on :%s", port)
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("ListenAndServe: %v", err)
	}
}

func (s *Server) migrate(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS contacts (
	id            BIGSERIAL PRIMARY KEY,
	name          TEXT NOT NULL DEFAULT '',
	phone         TEXT NOT NULL DEFAULT '',
	email         TEXT NOT NULL DEFAULT '',
	organization  TEXT NOT NULL DEFAULT '',
	position      TEXT NOT NULL DEFAULT '',
	org_type      TEXT NOT NULL DEFAULT '',
	notes         TEXT NOT NULL DEFAULT '',
	curator_email TEXT NOT NULL DEFAULT '',
	created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS contacts_permissions (
	app   TEXT NOT NULL,
	email TEXT NOT NULL,
	role  TEXT NOT NULL,
	PRIMARY KEY (app, email)
)`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS contacts_common_access (
	app    TEXT PRIMARY KEY,
	level  TEXT NOT NULL DEFAULT ''
)`); err != nil {
		return err
	}
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	var req PushRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if len(req.Contacts) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"inserted": 0, "updated": 0})
		return
	}

	now := time.Now().UTC()
	inserted := 0
	updated := 0
	for _, c := range req.Contacts {
		updatedAt := parseTime(c.UpdatedAt, now)

		if c.ID > 0 {
			tag, err := s.pool.Exec(r.Context(), `
UPDATE contacts SET
	name = $2, phone = $3, email = $4, organization = $5, position = $6,
	org_type = $7, notes = $8, curator_email = $9, updated_at = $10
WHERE id = $1 AND updated_at < $10`, c.ID, c.Name, c.Phone, c.Email,
				c.Organization, c.Position, c.OrgType, c.Notes, c.CuratorEmail, updatedAt)
			if err != nil {
				log.Printf("push update: %v", err)
				continue
			}
			if tag.RowsAffected() > 0 {
				updated++
				continue
			}
			insTag, err := s.pool.Exec(r.Context(), `
INSERT INTO contacts (id, name, phone, email, organization, position, org_type, notes,
	curator_email, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
ON CONFLICT (id) DO NOTHING`, c.ID, c.Name, c.Phone, c.Email,
				c.Organization, c.Position, c.OrgType, c.Notes, c.CuratorEmail, updatedAt)
			if err != nil {
				log.Printf("push insert by id: %v", err)
				continue
			}
			if insTag.RowsAffected() > 0 {
				inserted++
				s.bumpSequence(r.Context())
			}
			continue
		}

		_, err := s.pool.Exec(r.Context(), `
INSERT INTO contacts (name, phone, email, organization, position, org_type, notes,
	curator_email, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`, c.Name, c.Phone, c.Email,
			c.Organization, c.Position, c.OrgType, c.Notes, c.CuratorEmail, updatedAt)
		if err != nil {
			log.Printf("push insert: %v", err)
			continue
		}
		inserted++
	}

	writeJSON(w, http.StatusOK, map[string]any{"inserted": inserted, "updated": updated})
}

func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
SELECT id, name, phone, email, organization, position, org_type, notes,
	curator_email, created_at, updated_at
FROM contacts ORDER BY id`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	contacts := make([]Contact, 0, 64)
	for rows.Next() {
		var c Contact
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&c.ID, &c.Name, &c.Phone, &c.Email, &c.Organization,
			&c.Position, &c.OrgType, &c.Notes, &c.CuratorEmail, &createdAt, &updatedAt); err != nil {
			log.Printf("pull scan: %v", err)
			continue
		}
		c.CreatedAt = createdAt.Format(time.RFC3339)
		c.UpdatedAt = updatedAt.Format(time.RFC3339)
		contacts = append(contacts, c)
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"contacts": contacts})
}

// handleDelete удаляет контакт. Доступ: admin ИЛИ куратор контакта.
func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	email, ok := r.Context().Value(permEmailCtx{}).(string)
	if !ok || email == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	role, _ := r.Context().Value(permRoleCtx{}).(string)

	var req struct {
		ID int64 `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if req.ID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "id is required"})
		return
	}

	var curatorEmail string
	err := s.pool.QueryRow(r.Context(),
		`SELECT curator_email FROM contacts WHERE id = $1`, req.ID).Scan(&curatorEmail)
	if err != nil {
		log.Printf("delete select: %v", err)
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "contact not found"})
		return
	}

	if role != "admin" && curatorEmail != email {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: only curator or admin can delete"})
		return
	}

	if _, err := s.pool.Exec(r.Context(),
		`DELETE FROM contacts WHERE id = $1`, req.ID); err != nil {
		log.Printf("delete: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": 1})
}

func (s *Server) bumpSequence(ctx context.Context) {
	_, _ = s.pool.Exec(ctx, `
SELECT setval(pg_get_serial_sequence('contacts', 'id'),
	GREATEST((SELECT COALESCE(MAX(id), 0) FROM contacts), (SELECT last_value FROM contacts_id_seq)), true)`)
}

func parseTime(v string, fallback time.Time) time.Time {
	if v == "" {
		return fallback
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return fallback
	}
	return t
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}
