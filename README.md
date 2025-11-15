# RoutePlanner – Backend API

Node.js backend for the **RoutePlanner** application.  
Provides authentication, route management and integration with external services (routing, maps, etc.) for the React frontend.

---

##  Main Features

- **JWT-based authentication** – register, login, protected routes  
- **User management** – each user sees only their own routes  
- **Route CRUD** – create, read, update and delete routes  
- **Route generation** – generates hiking/biking routes using an external routing API  
- **MongoDB storage** – users and routes stored in a database  
- Centralized error handling and validation

---

## Tech Stack

- **Node.js**, **Express.js**
- **MongoDB** + **Mongoose**
- **JWT** for authentication
- **dotenv** for environment variables
