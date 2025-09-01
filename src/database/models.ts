import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Check } from 'typeorm';

export enum UserType {
  ADMIN = 'admin',
  NORMAL = 'normal',
}

@Entity()
@Check(`"tipo" IN ('admin','normal')`)
export class Usuario {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  nombre!: string;

  @Column({ unique: true })
  numeroWhatsapp!: string;

  @Column({ type: 'text' })
  tipo!: UserType;

  @CreateDateColumn()
  fechaRegistro!: Date;

  @Column({ default: true })
  activo!: boolean;
}

@Entity()
export class Auditoria {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Usuario)
  @JoinColumn({ name: 'usuarioId' })
  usuario!: Usuario;

  @Column()
  accion!: string;

  @CreateDateColumn()
  fechaHora!: Date;

  @Column({ type: 'simple-json', nullable: true })
  detalles?: any;
}

@Entity()
export class Blacklist {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  numeroWhatsapp!: string;

  @CreateDateColumn()
  fechaRegistro!: Date;

  @Column({ default: true })
  activo!: boolean;
}

@Entity()
export class Attempt {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  numeroWhatsapp!: string;

  @Column({ default: 0 })
  conteo!: number;

  @CreateDateColumn()
  fechaPrimerIntento!: Date;

  @Column({ type: 'datetime', nullable: true })
  ultimaActualizacion!: Date;
}

@Entity()
export class AuditContext {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  adminNumeroWhatsapp!: string;

  @Column({ nullable: true })
  filterNumeroWhatsapp?: string;

  @Column({ default: 0 })
  offset!: number;

  @Column({ type: 'datetime', nullable: true })
  lastInteraction!: Date;

  @Column({ default: false })
  awaitingFilter!: boolean;
}
