COMPOSE = docker compose -f infra/docker-compose.dev.yml

.PHONY: up down logs db reset-db db-roles db-roles-test

# Passwords come from .env (DB_APP_PASSWORD / DB_MIGRATOR_PASSWORD), so they
# never end up in the shell history or in git.
ROLE_ARGS = -v ON_ERROR_STOP=1 \
	-v app_password="$$(grep -E '^DB_APP_PASSWORD=' .env | cut -d= -f2-)" \
	-v migrator_password="$$(grep -E '^DB_MIGRATOR_PASSWORD=' .env | cut -d= -f2-)"


up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

db:
	$(COMPOSE) exec postgres psql -U ae_dev -d amar_elaka

reset-db:
	@echo "This will DELETE all data in the postgres/redis/meilisearch volumes."
	@read -p "Are you sure? [y/N] " confirm; \
	if [ "$$confirm" = "y" ] || [ "$$confirm" = "Y" ]; then \
		$(COMPOSE) down -v; \
		$(COMPOSE) up -d postgres; \
	else \
		echo "Aborted."; \
	fi

# Creates (or rotates) ae_app and ae_migrator. Run once per database.
db-roles:
	$(COMPOSE) exec -T postgres psql -U ae_dev -d amar_elaka $(ROLE_ARGS) < infra/db/bootstrap-roles.sql

db-roles-test:
	$(COMPOSE) exec -T postgres psql -U ae_dev -d amar_elaka_test $(ROLE_ARGS) < infra/db/bootstrap-roles.sql
