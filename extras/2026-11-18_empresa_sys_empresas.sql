-- =====================================================================
-- BMNFe — empresa_id das tabelas nfe_* passa a ser o sys_empresas.id
--
-- Para o erp-vendas (e qualquer módulo do ERP) falar com o BMNFe pela mesma
-- empresa que ele usa em todo o resto.
--
-- Como é hoje: o empresa_id gravado é o nfe_empresas.id. O login liga o
-- usuário (sys_usuarios) ao emitente pelo CNPJ: sys_empresas.cnpj = nfe_empresas.cnpj
-- (server/auth.ts, carregarUsuario). No bmerp_000000, em 18/11/2026, os dois ids
-- coincidem (só a empresa 1 tem emitente), mas nada garantia isso.
--
-- Como fica: nfe_empresas vira a extensão fiscal 1:1 da sys_empresas, com
-- id = sys_empresas.id (sem AUTO_INCREMENT). Ela continua existindo porque
-- guarda o que a sys_empresas não tem e a NF-e exige: crt, codigo_municipio
-- (IBGE) e o endereço no formato do XML. Toda tabela nfe_* aponta para a
-- sys_empresas. O código não muda: o JOIN por CNPJ do login devolve o mesmo id.
--
-- Emitente novo, daqui em diante:
--   INSERT INTO nfe_empresas (id, cnpj, razao_social, ...) VALUES (<sys_empresas.id>, ...);
--
-- nfe_log não tem FK (o log nunca pode barrar a operação): só muda o tipo.
-- nfe_usuarios está no bmnfe_schema.sql mas não existe no banco (o login é o
-- sys_usuarios): fica fora.
-- =====================================================================

-- 1) ANTES de tudo. Tem de voltar vazia: cada emitente precisa da empresa do
--    ERP com o mesmo CNPJ e o MESMO id. Se voltar linha, pare: os ids terão de
--    ser remapeados caso a caso antes deste script.
SELECT e.id AS nfe_id, e.cnpj, se.id AS sys_id
  FROM nfe_empresas e
  LEFT JOIN sys_empresas se ON se.cnpj = e.cnpj COLLATE utf8mb4_unicode_ci
 WHERE se.id IS NULL OR se.id <> e.id;

-- 2) Solta as FKs para nfe_empresas (o tipo da coluna não muda com a FK presa)
ALTER TABLE nfe_config        DROP FOREIGN KEY fk_nfe_config_empresa;
ALTER TABLE nfe_certificados  DROP FOREIGN KEY fk_nfe_certificados_empresa;
ALTER TABLE nfe_documentos    DROP FOREIGN KEY fk_nfe_documentos_empresa;
ALTER TABLE nfe_numeracao     DROP FOREIGN KEY fk_nfe_numeracao_empresa;
ALTER TABLE nfe_series        DROP FOREIGN KEY fk_nfe_series_empresa;
ALTER TABLE nfe_eventos       DROP FOREIGN KEY fk_nfe_eventos_empresa;
ALTER TABLE nfe_inutilizacoes DROP FOREIGN KEY fk_nfe_inutilizacoes_empresa;
ALTER TABLE nfe_distribuicao  DROP FOREIGN KEY fk_nfe_distribuicao_empresa;

-- 3) Mesmo tipo do sys_empresas.id
ALTER TABLE nfe_empresas      MODIFY id         BIGINT UNSIGNED NOT NULL;
ALTER TABLE nfe_config        MODIFY empresa_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE nfe_certificados  MODIFY empresa_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE nfe_documentos    MODIFY empresa_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE nfe_numeracao     MODIFY empresa_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE nfe_series        MODIFY empresa_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE nfe_eventos       MODIFY empresa_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE nfe_inutilizacoes MODIFY empresa_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE nfe_distribuicao  MODIFY empresa_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE nfe_log           MODIFY empresa_id BIGINT UNSIGNED NOT NULL;

-- 4) FKs para sys_empresas (mesmos nomes de antes; a da nfe_empresas é nova)
ALTER TABLE nfe_empresas      ADD CONSTRAINT fk_nfe_empresas_sys          FOREIGN KEY (id)         REFERENCES sys_empresas (id);
ALTER TABLE nfe_config        ADD CONSTRAINT fk_nfe_config_empresa        FOREIGN KEY (empresa_id) REFERENCES sys_empresas (id);
ALTER TABLE nfe_certificados  ADD CONSTRAINT fk_nfe_certificados_empresa  FOREIGN KEY (empresa_id) REFERENCES sys_empresas (id);
ALTER TABLE nfe_documentos    ADD CONSTRAINT fk_nfe_documentos_empresa    FOREIGN KEY (empresa_id) REFERENCES sys_empresas (id);
ALTER TABLE nfe_numeracao     ADD CONSTRAINT fk_nfe_numeracao_empresa     FOREIGN KEY (empresa_id) REFERENCES sys_empresas (id);
ALTER TABLE nfe_series        ADD CONSTRAINT fk_nfe_series_empresa        FOREIGN KEY (empresa_id) REFERENCES sys_empresas (id);
ALTER TABLE nfe_eventos       ADD CONSTRAINT fk_nfe_eventos_empresa       FOREIGN KEY (empresa_id) REFERENCES sys_empresas (id);
ALTER TABLE nfe_inutilizacoes ADD CONSTRAINT fk_nfe_inutilizacoes_empresa FOREIGN KEY (empresa_id) REFERENCES sys_empresas (id);
ALTER TABLE nfe_distribuicao  ADD CONSTRAINT fk_nfe_distribuicao_empresa  FOREIGN KEY (empresa_id) REFERENCES sys_empresas (id);

-- =====================================================================
-- Reversão (volta para INT UNSIGNED com FK para nfe_empresas)
-- =====================================================================
-- ALTER TABLE nfe_empresas      DROP FOREIGN KEY fk_nfe_empresas_sys;
-- ALTER TABLE nfe_config        DROP FOREIGN KEY fk_nfe_config_empresa;
-- ALTER TABLE nfe_certificados  DROP FOREIGN KEY fk_nfe_certificados_empresa;
-- ALTER TABLE nfe_documentos    DROP FOREIGN KEY fk_nfe_documentos_empresa;
-- ALTER TABLE nfe_numeracao     DROP FOREIGN KEY fk_nfe_numeracao_empresa;
-- ALTER TABLE nfe_series        DROP FOREIGN KEY fk_nfe_series_empresa;
-- ALTER TABLE nfe_eventos       DROP FOREIGN KEY fk_nfe_eventos_empresa;
-- ALTER TABLE nfe_inutilizacoes DROP FOREIGN KEY fk_nfe_inutilizacoes_empresa;
-- ALTER TABLE nfe_distribuicao  DROP FOREIGN KEY fk_nfe_distribuicao_empresa;
--
-- ALTER TABLE nfe_empresas      MODIFY id         INT UNSIGNED NOT NULL AUTO_INCREMENT;
-- ALTER TABLE nfe_config        MODIFY empresa_id INT UNSIGNED NOT NULL;
-- ALTER TABLE nfe_certificados  MODIFY empresa_id INT UNSIGNED NOT NULL;
-- ALTER TABLE nfe_documentos    MODIFY empresa_id INT UNSIGNED NOT NULL;
-- ALTER TABLE nfe_numeracao     MODIFY empresa_id INT UNSIGNED NOT NULL;
-- ALTER TABLE nfe_series        MODIFY empresa_id INT UNSIGNED NOT NULL;
-- ALTER TABLE nfe_eventos       MODIFY empresa_id INT UNSIGNED NOT NULL;
-- ALTER TABLE nfe_inutilizacoes MODIFY empresa_id INT UNSIGNED NOT NULL;
-- ALTER TABLE nfe_distribuicao  MODIFY empresa_id INT UNSIGNED NOT NULL;
-- ALTER TABLE nfe_log           MODIFY empresa_id INT UNSIGNED NOT NULL;
--
-- ALTER TABLE nfe_config        ADD CONSTRAINT fk_nfe_config_empresa        FOREIGN KEY (empresa_id) REFERENCES nfe_empresas (id);
-- ALTER TABLE nfe_certificados  ADD CONSTRAINT fk_nfe_certificados_empresa  FOREIGN KEY (empresa_id) REFERENCES nfe_empresas (id);
-- ALTER TABLE nfe_documentos    ADD CONSTRAINT fk_nfe_documentos_empresa    FOREIGN KEY (empresa_id) REFERENCES nfe_empresas (id);
-- ALTER TABLE nfe_numeracao     ADD CONSTRAINT fk_nfe_numeracao_empresa     FOREIGN KEY (empresa_id) REFERENCES nfe_empresas (id);
-- ALTER TABLE nfe_series        ADD CONSTRAINT fk_nfe_series_empresa        FOREIGN KEY (empresa_id) REFERENCES nfe_empresas (id);
-- ALTER TABLE nfe_eventos       ADD CONSTRAINT fk_nfe_eventos_empresa       FOREIGN KEY (empresa_id) REFERENCES nfe_empresas (id);
-- ALTER TABLE nfe_inutilizacoes ADD CONSTRAINT fk_nfe_inutilizacoes_empresa FOREIGN KEY (empresa_id) REFERENCES nfe_empresas (id);
-- ALTER TABLE nfe_distribuicao  ADD CONSTRAINT fk_nfe_distribuicao_empresa  FOREIGN KEY (empresa_id) REFERENCES nfe_empresas (id);
